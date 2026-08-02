"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { HttpClient, createWooAxios, createStrapiAxios } = require("./lib/httpClient");
const WooSource = require("./lib/wooSource");
const StrapiRepo = require("./lib/strapiRepo");
const MappingStore = require("./lib/mapping");
const MediaSync = require("./lib/media");
const { ImportReport } = require("./lib/report");
const { resolveScope, needsProductLoop } = require("./lib/presets");
const T = require("./lib/transforms");
const G = require("./lib/genericAttributes");

function normalizeRunLimit(limit) {
  return Number.isFinite(limit) ? limit : "all";
}

function parseRunLimit(limit) {
  return limit === "all" || limit === null || limit === undefined ? Infinity : Number(limit);
}

function parseOptionalPositiveInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

/**
 * True when an existing Strapi product already has BOTH a cover image and a
 * non-empty media gallery. Tolerant of Strapi v4 relation shapes
 * (`{ data: {...} }` / `{ data: [...] }`) and raw values. Used by the `full-sync`
 * scope to decide whether media import can be safely skipped.
 *
 * @param {{ attributes?: object } | object} existing index entry
 */
function productHasMedia(existing) {
  const attrs = existing?.attributes ?? existing ?? {};
  const cover = attrs.CoverImage?.data ?? attrs.CoverImage;
  const gallery = attrs.Media?.data ?? attrs.Media;
  const hasCover = Array.isArray(cover) ? cover.length > 0 : Boolean(cover);
  const hasGallery = Array.isArray(gallery) ? gallery.length > 0 : Boolean(gallery);
  return hasCover && hasGallery;
}

function isRunControlError(error) {
  return error?.code === "CATALOG_RUN_CANCELLED" || error?.code === "CATALOG_RUN_PAUSED";
}

/**
 * Sort WooCommerce categories parents-first, including orphans (parent missing in
 * the set is treated as root). Cycle-safe. Ported from the legacy CategoryImporter.
 */
function sortCategoriesByHierarchy(categories) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const roots = categories.filter((c) => !c.parent || c.parent === 0 || !byId.has(c.parent));
  const sorted = [];
  const visited = new Set();

  const visit = (cat, ancestors) => {
    if (ancestors.includes(cat.id) || visited.has(cat.id)) return;
    visited.add(cat.id);
    sorted.push(cat);
    const next = [...ancestors, cat.id];
    categories.filter((c) => c.parent === cat.id).forEach((child) => visit(child, next));
  };
  roots.forEach((r) => visit(r, []));
  return sorted;
}

class CatalogEngine {
  /**
   * @param {object} config
   * @param {object} logger
   * @param {object} [options]
   */
  constructor(config, logger, options = {}) {
    this.config = config;
    this.logger = logger;
    this.options = options;

    const wooHttp = new HttpClient(createWooAxios(config), {
      logger,
      maxRetries: config.catalog.maxRetries,
      baseDelay: config.catalog.baseRetryDelay,
    });
    const strapiHttp = new HttpClient(createStrapiAxios(config), {
      logger,
      maxRetries: config.catalog.maxRetries,
      baseDelay: config.catalog.baseRetryDelay,
    });

    this.woo = new WooSource(wooHttp, { defaultPerPage: config.catalog.perPage, logger });
    this.repo = new StrapiRepo(strapiHttp, logger);
    this.mapping = new MappingStore(config.duplicateTracking.storageDir, { logger });
    this.mediaStore = new MappingStore(config.duplicateTracking.storageDir, {
      logger,
      fileName: "catalog-media-mappings.json",
    });
    this.media = new MediaSync(config, logger, this.mediaStore, {
      allowHttp: config.catalog.allowHttpMedia,
    });

    this.multiplier = config.import.currency.multiplier || 1;
    this.statusMappings = config.import.statusMappings.product || {};
  }

  async preflight() {
    this.logger.info("Checking API connectivity…");
    try {
      await this.woo.http.get("/products", { params: { per_page: 1 } });
      this.logger.info("✓ WooCommerce reachable");
    } catch (error) {
      const status = error.response?.status;
      throw new Error(`WooCommerce connectivity failed${status ? ` (HTTP ${status})` : ""}: ${error.message}`);
    }
    try {
      await this.repo.http.get("/product-categories", { params: { "pagination[pageSize]": 1 } });
      this.logger.info("✓ Strapi reachable");
    } catch (error) {
      const status = error.response?.status;
      throw new Error(`Strapi connectivity failed${status ? ` (HTTP ${status})` : ""}: ${error.message}`);
    }
    this.logger.success("WooCommerce and Strapi reachable");
  }

  /**
   * @param {object} opts
   * @param {boolean} [opts.dryRun=false]
   * @param {string}  [opts.scope="full"]   full | no-media | categories | stock | price | media
   * @param {boolean} [opts.skipMedia=false]
   * @param {number}  [opts.limit=Infinity]
   */
  async runSync(opts = {}) {
    let dryRun = Boolean(opts.dryRun);
    let limit = opts.limit ?? Infinity;
    const categoryLimit = opts.categoryLimit ?? Infinity;
    let scope = opts.scope || "full";
    let skipMedia = Boolean(opts.skipMedia);
    let startAfterExternalId = parseOptionalPositiveInt(opts.startAfterExternalId);
    const runStore = opts.runStore || null;
    let run = null;
    let lockToken = null;

    if (runStore && opts.resume) {
      run = runStore.getRun(opts.runId);
      if (!runStore.isResumable(run)) {
        throw new Error(`Catalog run ${run.id} is not resumable (status: ${run.status})`);
      }
      dryRun = Boolean(run.options?.dryRun);
      scope = run.options?.scope || scope;
      skipMedia = Boolean(run.options?.skipMedia);
      limit = parseRunLimit(run.options?.limit);
      startAfterExternalId = parseOptionalPositiveInt(run.options?.startAfterExternalId);
    } else if (runStore) {
      run = runStore.createRun({
        runId: opts.runId,
        command: dryRun ? `dry-run:${scope}` : `sync:${scope}`,
        environment: this.options.environment || "production",
        strapiBaseUrl: this.config.strapi.baseUrl,
        options: {
          dryRun,
          scope,
          skipMedia,
          limit: normalizeRunLimit(limit),
          startAfterExternalId,
        },
      });
    }

    const flags = resolveScope(scope, { skipMedia });

    const report = new ImportReport({
      command: dryRun ? `dry-run:${scope}` : `sync:${scope}`,
      environment: this.options.environment || "production",
      trackingDir: this.config.catalog.trackingDirAbs,
      logger: this.logger,
    });

    const runContext = runStore && run
      ? {
          store: runStore,
          runId: run.id,
          retryFailed: Boolean(opts.retryFailed),
          pauseSignalPath: opts.pauseSignalPath,
          shouldCancel: opts.shouldCancel,
        }
      : null;

    this.logger.info(`Scope: ${scope} → ${JSON.stringify(flags)}`);
    if (runContext) {
      lockToken = runStore.acquireLock(run.id);
      runContext.lockToken = lockToken;
    }

    try {
      await this.preflight();

    // Attribute cache only matters when we write variations with attributes.
    if (flags.variations && flags.variationFields === "all") {
      await this.repo.preloadAttributes();
      await this.repo.preloadGenericAttributes();
    }
    if (flags.products) {
      await this.repo.preloadProductTags();
    }

    if (flags.categories) {
      await this.syncCategories(report, dryRun, runContext, categoryLimit);
    }
    if (needsProductLoop(flags)) {
      await this.syncProducts(report, dryRun, flags, limit, runContext, {
        startAfterExternalId,
        observer: opts.observer || null,
        onlyExternalIds: opts.onlyExternalIds || null,
      });
    }

    if (!dryRun) {
      this.mapping.flush();
      this.mediaStore.flush();
    }

      report.printSummary();
      report.save();
      if (runContext) {
        runStore.finalizeFromReport(run.id, report.toJSON(), report.hasFailures() ? "resumable" : "completed");
      }
      return report;
    } catch (error) {
      if (runContext) {
        const status = error.code === "CATALOG_RUN_PAUSED"
          ? "paused"
          : error.code === "CATALOG_RUN_CANCELLED"
            ? "cancelled"
            : "failed";
        runStore.setStatus(run.id, status, {
          currentStep: status,
          lastError: error.message,
        });
      }
      throw error;
    } finally {
      if (runContext && lockToken) {
        runStore.releaseLock(run.id, lockToken);
      }
    }
  }

  async ensureRunCanContinue(runContext) {
    if (!runContext) return;
    if (runContext.lockToken) {
      runContext.store.heartbeat(runContext.runId, runContext.lockToken);
    }
    if (runContext.pauseSignalPath && fs.existsSync(runContext.pauseSignalPath)) {
      const error = new Error(`Catalog run ${runContext.runId} paused by signal file`);
      error.code = "CATALOG_RUN_PAUSED";
      throw error;
    }
    if (runContext.shouldCancel && await runContext.shouldCancel()) {
      const error = new Error(`Catalog run ${runContext.runId} cancelled by caller`);
      error.code = "CATALOG_RUN_CANCELLED";
      throw error;
    }
    const run = runContext.store.getRun(runContext.runId);
    if (run.pauseRequested) {
      const error = new Error(`Catalog run ${runContext.runId} pause requested`);
      error.code = "CATALOG_RUN_PAUSED";
      throw error;
    }
    if (run.cancelRequested) {
      const error = new Error(`Catalog run ${runContext.runId} cancel requested`);
      error.code = "CATALOG_RUN_CANCELLED";
      throw error;
    }
  }

  shouldSkipTrackedItem(runContext, key) {
    if (runContext?.retryFailed && (key.startsWith("product:") || key.startsWith("variation:"))) {
      const item = runContext.store.getItem(runContext.runId, key);
      if (item?.status === "completed" || item?.status === "skipped") {
        return false;
      }
    }
    return Boolean(runContext?.store.shouldSkipItem(runContext.runId, key, {
      retryFailed: runContext.retryFailed,
    }));
  }

  async syncCategories(report, dryRun, runContext = null, limit = Infinity) {
    this.logger.info("Phase: categories");
    if (runContext) runContext.store.setCurrentStep(runContext.runId, "categories");
    const wcCategories = await this.woo.fetchAllCategories();
    const sorted = sortCategoriesByHierarchy(wcCategories).slice(0, limit);
    const index = await this.repo.buildExternalIndex("/product-categories");

    for (const wc of sorted) {
      const itemKey = `category:${wc.id}`;
      try {
        await this.ensureRunCanContinue(runContext);
        if (this.shouldSkipTrackedItem(runContext, itemKey)) {
          report.count("categories", "skipped");
          continue;
        }
        if (runContext) {
          runContext.store.beginItem(runContext.runId, itemKey, {
            entity: "categories",
            wcId: wc.id,
            name: wc.name,
            stage: "upsert-category",
          });
        }
        const resolveParentId = (wooParentId) => this.mapping.getStrapiId("categories", wooParentId);
        const { data } = T.mapCategory(wc, resolveParentId);
        const existing = index.get(wc.id.toString());

        if (dryRun) {
          report.count("categories", existing ? "updated" : "created");
          if (runContext) {
            runContext.store.completeItem(runContext.runId, itemKey, {
              mode: existing ? "updated" : "created",
              fingerprint: fingerprint(data),
            });
          }
          continue;
        }

        const { id, mode } = await this.repo.upsert({
          endpoint: "/product-categories",
          externalId: wc.id.toString(),
          payload: data,
          index,
        });
        // Store parentWcId so syncOneProduct can resolve parent-child hierarchy for main-category selection.
        this.mapping.set("categories", wc.id, id, { name: wc.name, slug: data.Slug, parentWcId: wc.parent || null });
        report.count("categories", mode);
        if (runContext) {
          runContext.store.completeItem(runContext.runId, itemKey, {
            mode,
            strapiId: id,
            fingerprint: fingerprint(data),
          });
        }
      } catch (error) {
        if (isRunControlError(error)) throw error;
        report.fail("categories", { wcId: wc.id, stage: "upsert-category", error });
        if (runContext) {
          runContext.store.failItem(runContext.runId, itemKey, {
            entity: "categories",
            wcId: wc.id,
            stage: "upsert-category",
            error,
          });
        }
        this.logger.error(`❌ category ${wc.id} (${wc.name}): ${error.message}`);
      }
    }
    if (!dryRun) this.mapping.flush();
  }

  async syncProducts(report, dryRun, flags, limit = Infinity, runContext = null, options = {}) {
    this.logger.info("Phase: products + variations");
    if (runContext) runContext.store.setCurrentStep(runContext.runId, "products");
    // In "preserve" media mode we need to know whether each existing product
    // already has media, so populate (id-only) the cover/gallery relations.
    const productIndexParams = flags.mediaPolicy === "preserve"
      ? { "populate[CoverImage][fields][0]": "id", "populate[Media][fields][0]": "id" }
      : {};
    const ctx = {
      report,
      dryRun,
      flags,
      runContext,
      productIndex: await this.repo.buildExternalIndex("/products", productIndexParams),
      variationIndex: await this.repo.buildExternalIndex("/product-variations"),
      stockIndex: await this.repo.buildExternalIndex("/product-stocks"),
      globalAttributeRegistry:
        flags.variations && flags.variationFields === "all"
          ? await this.woo.fetchGlobalAttributeRegistry()
          : new Map(),
      observer: options.observer || null,
    };

    let processed = 0;
    const onlyExternalIds = options.onlyExternalIds
      ? new Set(Array.from(options.onlyExternalIds, (value) => String(value)))
      : null;
    for await (const wcProduct of this.woo.iterateProducts()) {
      try {
        await this.ensureRunCanContinue(runContext);
        if (onlyExternalIds && !onlyExternalIds.has(String(wcProduct.id))) continue;
        if (options.startAfterExternalId && Number(wcProduct.id) <= options.startAfterExternalId) {
          report.count("products", "skipped");
          continue;
        }
        if (processed >= limit) break;
        processed += 1;
        await this.syncOneProduct(wcProduct, ctx);
      } catch (error) {
        if (isRunControlError(error)) throw error;
        report.fail("products", { wcId: wcProduct.id, stage: "sync-product", error });
        if (runContext) {
          runContext.store.failItem(runContext.runId, `product:${wcProduct.id}`, {
            entity: "products",
            wcId: wcProduct.id,
            stage: "sync-product",
            error,
          });
        }
        this.logger.error(`❌ product ${wcProduct.id} (${wcProduct.name}): ${error.message}`);
      }
    }
  }

  async syncOneProduct(wcProduct, ctx) {
    const { report, dryRun, flags, productIndex, runContext } = ctx;
    const itemKey = `product:${wcProduct.id}`;

    if (this.shouldSkipTrackedItem(runContext, itemKey)) {
      report.count("products", "skipped");
      return;
    }

    if (runContext) {
      runContext.store.beginItem(runContext.runId, itemKey, {
        entity: "products",
        wcId: wcProduct.id,
        name: wcProduct.name,
        stage: "sync-product",
      });
    }

    if (!wcProduct.name || wcProduct.name.trim() === "") {
      report.fail("products", { wcId: wcProduct.id, stage: "validate", error: "missing name" });
      if (runContext) {
        runContext.store.failItem(runContext.runId, itemKey, {
          entity: "products",
          wcId: wcProduct.id,
          stage: "validate",
          error: "missing name",
        });
      }
      return;
    }

    const isSimple =
      wcProduct.type === "simple" ||
      !Array.isArray(wcProduct.variations) ||
      wcProduct.variations.length === 0;
    const wcVariations = isSimple ? [] : await this.woo.fetchAllVariations(wcProduct.id);
    const stockEligibility = T.evaluateProductStockEligibility(wcProduct, wcVariations);
    if (!stockEligibility.eligible) {
      ctx.observer?.onProduct?.({ wcProduct, wcVariations, stockEligibility });
      report.count("products", "skipped");
      if (runContext) {
        runContext.store.completeItem(runContext.runId, itemKey, {
          status: "skipped",
          reason: stockEligibility.reason,
          unmanagedVariationIds: stockEligibility.unmanagedVariationIds,
        });
      }
      return;
    }
    ctx.observer?.onProduct?.({ wcProduct, wcVariations, stockEligibility });
    const attributePlan = G.buildProductAttributePlan(wcProduct, ctx.globalAttributeRegistry);

    const existing = productIndex.get(wcProduct.id.toString());
    let productStrapiId = existing?.id || this.mapping.getStrapiId("products", wcProduct.id);
    let productFingerprint = null;

    // Product record write (only in scopes that touch products).
    if (flags.products) {
      const resolveCategoryId = (wooId) => this.mapping.getStrapiId("categories", wooId);
      const resolveCategoryParent = (wooId) => this.mapping.get("categories", wooId)?.parentWcId ?? null;
      const { data, sizeGuideMatrix } = T.mapProduct(wcProduct, {
        resolveCategoryId,
        resolveCategoryParent,
        statusMappings: this.statusMappings,
      });
      if (dryRun) {
        const tagCounters = this.repo.inspectProductTags(wcProduct.tags);
        report.count("productTags", "created", tagCounters.created);
        report.count("productTags", "unchanged", tagCounters.unchanged);
      } else {
        const tagResult = await this.repo.syncProductTags(wcProduct.tags);
        data.product_tags = tagResult.ids;
        report.count("productTags", "created", tagResult.counters.created);
        report.count("productTags", "unchanged", tagResult.counters.unchanged);
      }
      productFingerprint = fingerprint({ data, sizeGuideMatrix });

      if (dryRun) {
        report.count("products", existing ? "updated" : "created");
        report.count("sizeHelpers", sizeGuideMatrix ? "skipped" : "unchanged");
        productStrapiId = existing?.id || -1;
      } else {
        const { id, mode } = await this.repo.upsert({
          endpoint: "/products",
          externalId: wcProduct.id.toString(),
          payload: data,
          index: productIndex,
        });
        this.mapping.set("products", wcProduct.id, id, { name: wcProduct.name, slug: data.Slug });
        report.count("products", mode);
        productStrapiId = id;

        try {
          const helperMode = await this.repo.syncProductSizeHelper(id, sizeGuideMatrix);
          report.count("sizeHelpers", helperMode);
        } catch (error) {
          report.fail("sizeHelpers", { wcId: wcProduct.id, stage: "sync-size-guide", error });
          this.logger.warn(`⚠️ size guide ${wcProduct.id} (${wcProduct.name}): ${error.message}`);
        }
      }
    } else if (flags.onlyExisting && !productStrapiId) {
      // stock/price/media scopes: skip products that were never imported.
      report.count("products", "skipped");
      if (runContext) {
        runContext.store.completeItem(runContext.runId, itemKey, { status: "skipped", reason: "missing-existing-product" });
      }
      return;
    }

    let attributeContext = { plan: attributePlan, resolvedDimensions: null };
    if (flags.variations && flags.variationFields === "all") {
      if (dryRun) {
        const counters = this.repo.inspectProductAttributePlan(attributePlan);
        report.count("attributes", "created", counters.created);
        report.count("attributes", "updated", counters.updated);
      } else {
        const synced = await this.repo.syncProductAttributePlan(attributePlan, productStrapiId);
        attributeContext = { plan: attributePlan, resolvedDimensions: synced.resolvedDimensions };
        report.count("attributes", "created", synced.counters.created);
        report.count("attributes", "updated", synced.counters.updated);
      }
    }

    // Media — attach only when ids are present (never null existing media on failure).
    if (flags.media && !dryRun && productStrapiId && productStrapiId > 0) {
      // "preserve" policy (full-sync): leave existing media untouched when a product
      // already has both a cover and a gallery; otherwise import (new products and
      // products missing a cover or gallery get backfilled).
      if (flags.mediaPolicy === "preserve" && existing && productHasMedia(existing)) {
        report.mediaSkippedExisting();
        this.logger.info(`🖼️  media preserved — product ${wcProduct.id} already has cover + gallery`);
      } else {
        const { coverId, galleryIds, counts } = await this.media.syncProductMedia(wcProduct);
        report.mediaUploaded(counts.uploaded);
        report.mediaReused(counts.reused);
        report.mediaFailed(counts.failed);
        const update = {};
        if (coverId) update.CoverImage = coverId;
        if (galleryIds.length > 0) update.Media = galleryIds;
        if (Object.keys(update).length > 0) {
          await this.repo.http.put(`/products/${productStrapiId}`, { data: update });
        } else {
          this.logger.info(`ℹ️  no media available in WooCommerce for product ${wcProduct.id}`);
        }
      }
    }

    if (flags.variations || flags.stock) {
      await this.syncVariations(
        wcProduct,
        productStrapiId,
        ctx,
        wcVariations,
        attributeContext,
      );
    }

    if (runContext) {
      runContext.store.completeItem(runContext.runId, itemKey, {
        strapiId: productStrapiId,
        fingerprint: productFingerprint,
      });
    }
  }

  async syncVariations(
    wcProduct,
    parentStrapiId,
    ctx,
    prefetchedVariations = [],
    attributeContext = { plan: { sourceProductId: wcProduct.id, dimensions: [] }, resolvedDimensions: null },
  ) {
    const isSimple =
      wcProduct.type === "simple" ||
      !Array.isArray(wcProduct.variations) ||
      wcProduct.variations.length === 0;

    if (isSimple) {
      const synthetic = T.synthesizeSimpleVariation(wcProduct);
      await this.syncOneVariation(synthetic, wcProduct, parentStrapiId, ctx, attributeContext);
      return;
    }

    for (const wcVariation of prefetchedVariations) {
      try {
        await this.ensureRunCanContinue(ctx.runContext);
        await this.syncOneVariation(wcVariation, wcProduct, parentStrapiId, ctx, attributeContext);
      } catch (error) {
        if (isRunControlError(error)) throw error;
        ctx.report.fail("variations", { wcId: wcVariation.id, stage: "sync-variation", error });
        if (ctx.runContext) {
          ctx.runContext.store.failItem(ctx.runContext.runId, `variation:${wcVariation.id}`, {
            entity: "variations",
            wcId: wcVariation.id,
            stage: "sync-variation",
            error,
          });
        }
        this.logger.error(`❌ variation ${wcVariation.id} (parent ${wcProduct.id}): ${error.message}`);
      }
    }
  }

  async syncOneVariation(wcVariation, parentProduct, parentStrapiId, ctx, attributeContext) {
    const { report, dryRun, flags, variationIndex, stockIndex, runContext } = ctx;
    const externalId = wcVariation.id.toString();
    const itemKey = `variation:${externalId}`;
    const existing = variationIndex.get(externalId);

    if (this.shouldSkipTrackedItem(runContext, itemKey)) {
      report.count("variations", "skipped");
      return;
    }

    if (runContext) {
      runContext.store.beginItem(runContext.runId, itemKey, {
        entity: "variations",
        wcId: wcVariation.id,
        parentWcId: parentProduct.id,
        stage: "sync-variation",
      });
    }

    // onlyExisting scopes (stock/price/media) never create new variations.
    if (flags.onlyExisting && !existing) {
      report.count("variations", "skipped");
      if (runContext) {
        runContext.store.completeItem(runContext.runId, itemKey, { status: "skipped", reason: "missing-existing-variation" });
      }
      return;
    }

    let variationStrapiId = existing?.id || this.mapping.getStrapiId("variations", wcVariation.id);
    let variationFingerprint = null;

    if (dryRun) {
      if (flags.variations) {
        const pricing = T.computeVariationPricing(wcVariation, parentProduct, this.multiplier);
        if (pricing.priceMissing && !existing) {
          report.fail("variations", { wcId: wcVariation.id, stage: "price", error: "no price in WooCommerce" });
          if (runContext) {
            runContext.store.failItem(runContext.runId, itemKey, {
              entity: "variations",
              wcId: wcVariation.id,
              stage: "price",
              error: "no price in WooCommerce",
            });
          }
          return;
        }
        const selection = G.selectVariationTerms(wcVariation, attributeContext.plan);
        if (selection.errors.length > 0) {
          const reasonCodes = selection.errors.map((error) => error.code).join(",");
          report.fail("attributes", {
            wcId: wcVariation.id,
            stage: "generic-attributes",
            error: reasonCodes,
          });
          if (runContext) {
            runContext.store.failItem(runContext.runId, itemKey, {
              entity: "variations",
              wcId: wcVariation.id,
              stage: "generic-attributes",
              error: reasonCodes,
            });
          }
          return;
        }
        report.count("variations", existing ? "updated" : "created");
      }
      if (flags.stock && (existing || !flags.onlyExisting)) {
        report.count("stocks", existing ? "updated" : "created");
      }
      if (runContext) {
        runContext.store.completeItem(runContext.runId, itemKey, { mode: existing ? "updated" : "created" });
      }
      return;
    }

    // --- Variation record write ---
    if (flags.variations) {
      if (flags.variationFields === "price-only") {
        // Update only Price/DiscountPrice on an existing variation; never create.
        if (variationStrapiId) {
          const pricing = T.computeVariationPricing(wcVariation, parentProduct, this.multiplier);
          if (!pricing.priceMissing) {
            const payload = { Price: pricing.price };
            payload.DiscountPrice = pricing.discountPrice ?? null;
            await this.repo.http.put(`/product-variations/${variationStrapiId}`, { data: payload });
            report.count("variations", "updated");
            variationFingerprint = fingerprint(payload);
          } else {
            report.count("variations", "skipped");
          }
        }
      } else {
        const { data, priceMissing } = T.mapVariation(wcVariation, {
          parentStrapiId,
          parentProduct,
          multiplier: this.multiplier,
          preserveMissingPrice: Boolean(existing),
        });
        if (priceMissing && !existing) {
          report.fail("variations", { wcId: wcVariation.id, stage: "price", error: "no price in WooCommerce" });
          if (runContext) {
            runContext.store.failItem(runContext.runId, itemKey, {
              entity: "variations",
              wcId: wcVariation.id,
              stage: "price",
              error: "no price in WooCommerce",
            });
          }
          return;
        }
        await this.attachAttributes(wcVariation, data, attributeContext);
        variationFingerprint = fingerprint(data);
        const { id, mode } = await this.repo.upsert({
          endpoint: "/product-variations",
          externalId,
          payload: data,
          index: variationIndex,
        });
        this.mapping.set("variations", wcVariation.id, id, { productId: parentProduct.id, sku: data.SKU });
        report.count("variations", mode);
        variationStrapiId = id;
      }
    }

    // --- Stock write ---
    if (flags.stock && variationStrapiId) {
      const stockKey = `stock:${wcVariation.id}`;
      const stock = T.mapStock(wcVariation);
      if (this.shouldSkipTrackedItem(runContext, stockKey)) {
        report.count("stocks", "skipped");
      } else {
        if (runContext) {
          runContext.store.beginItem(runContext.runId, stockKey, {
            entity: "stocks",
            wcId: wcVariation.id,
            parentWcId: parentProduct.id,
            stage: "sync-stock",
          });
        }
        const stockMode = await this.repo.upsertStock({
          externalId: stock.externalId,
          count: stock.count,
          variationId: variationStrapiId,
          stockIndex,
        });
        report.count("stocks", stockMode);
        if (runContext) {
          runContext.store.completeItem(runContext.runId, stockKey, {
            mode: stockMode,
            externalId: stock.externalId,
            fingerprint: fingerprint(stock),
          });
        }
      }
    }

    if (runContext) {
      runContext.store.completeItem(runContext.runId, itemKey, {
        strapiId: variationStrapiId,
        fingerprint: variationFingerprint,
      });
    }
  }

  /**
   * Compare WooCommerce and Strapi catalogs (read-only). Reports products present
   * in one store but not the other (by external_id). Returns `{ ok, wcOnly, strapiOnly }`.
   */
  async runVerify({ limit = Infinity } = {}) {
    await this.preflight();
    this.logger.info("Verify: comparing WooCommerce ↔ Strapi products by external_id");

    const wcIds = new Set();
    let processed = 0;
    for await (const wcProduct of this.woo.iterateProducts()) {
      if (processed >= limit) break;
      processed += 1;
      wcIds.add(wcProduct.id.toString());
    }

    const strapiIndex = await this.repo.buildExternalIndex("/products");
    const strapiIds = new Set(strapiIndex.keys());

    const wcOnly = [...wcIds].filter((id) => !strapiIds.has(id));
    const strapiOnly = [...strapiIds].filter((id) => !wcIds.has(id));

    this.logger.info(`WooCommerce products: ${wcIds.size}`);
    this.logger.info(`Strapi (woo-sourced) products: ${strapiIds.size}`);
    if (wcOnly.length > 0) {
      this.logger.warn(`Missing in Strapi (wcOnly): ${wcOnly.length} → e.g. ${wcOnly.slice(0, 10).join(", ")}`);
    }
    if (strapiOnly.length > 0) {
      this.logger.info(`Strapi-only (not in WC sample): ${strapiOnly.length}`);
    }

    return { ok: wcOnly.length === 0, wcOnly, strapiOnly };
  }

  async attachAttributes(wcVariation, data, attributeContext) {
    const selection = G.selectVariationTerms(wcVariation, attributeContext.plan);
    if (selection.errors.length > 0) {
      const error = new Error(
        `Variation attribute mapping failed: ${selection.errors.map((item) => item.code).join(",")}`,
      );
      error.code = "VARIATION_ATTRIBUTE_MAPPING_FAILED";
      throw error;
    }
    if (!attributeContext.resolvedDimensions) {
      throw new Error("Resolved product attributes are required for a write run");
    }

    data.product_variation_color = null;
    data.product_variation_size = null;
    data.product_variation_model = null;
    data.selected_attribute_terms = [];
    const signatureTokens = [];

    for (const { dimension, term } of selection.selected) {
      const resolvedDimension = attributeContext.resolvedDimensions.get(dimension.sourceKey);
      const resolvedTerm = resolvedDimension?.resolvedTerms.get(term.sourceKey);
      if (!resolvedDimension || !resolvedTerm?.id) {
        throw new Error(`Resolved attribute term missing: ${dimension.sourceKey}/${term.sourceKey}`);
      }

      if (dimension.legacyProjection === "Color") {
        if (!resolvedTerm.legacyId) throw new Error(`Legacy color projection missing: ${term.title}`);
        data.product_variation_color = resolvedTerm.legacyId;
        signatureTokens.push(`color=${resolvedTerm.legacyId}`);
      } else if (dimension.legacyProjection === "Size") {
        if (!resolvedTerm.legacyId) throw new Error(`Legacy size projection missing: ${term.title}`);
        data.product_variation_size = resolvedTerm.legacyId;
        signatureTokens.push(`size=${resolvedTerm.legacyId}`);
      } else {
        data.selected_attribute_terms.push(resolvedTerm.id);
        signatureTokens.push(`attribute:${resolvedDimension.definitionId}=${resolvedTerm.id}`);
      }
    }

    data.AttributeSignature = signatureTokens.sort().join("|");
  }
}

module.exports = { CatalogEngine, sortCategoriesByHierarchy };
