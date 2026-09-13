"use strict";

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { HttpClient, createWooAxios, createStrapiAxios } = require("./lib/httpClient");
const WooSource = require("./lib/wooSource");
const StrapiRepo = require("./lib/strapiRepo");
const MappingStore = require("./lib/mapping");
const { MediaMappingStore } = require("./lib/mediaMappingStore");
const MediaSync = require("./lib/media");
const { mapPoolOrdered, mapPoolAsync } = require("./lib/concurrency");
const { ImportReport } = require("./lib/report");
const { resolveScope, needsProductLoop } = require("./lib/presets");
const T = require("./lib/transforms");
const G = require("./lib/genericAttributes");
const CE = require("./lib/categoryEditorial");
const { sourceTimestampHeaders, wooSourceTimestamps } = require("../utils/sourceTimestamps");
const { createSourceGate } = require("../migration-v2/lib/sourceGate");

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

function readExpectedCategoryEditorialManifest(value) {
  if (!value) return null;
  if (typeof value === "object") return value.manifest || value;
  const filePath = path.resolve(process.cwd(), String(value));
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return parsed.manifest || parsed;
}

function assertMatchingCategoryEditorialManifest(expected, actual) {
  if (!expected) return;
  const comparable = (manifest) => ({
    version: manifest?.version,
    importSource: manifest?.importSource,
    sourceEndpoint: manifest?.sourceEndpoint,
    sourceCategoryCount: manifest?.sourceCategoryCount,
    nonEmptyCategoryCount: manifest?.nonEmptyCategoryCount,
    audioCount: manifest?.audioCount,
    rewrittenLinkCount: manifest?.rewrittenLinkCount,
    manifestHash: manifest?.manifestHash,
    batchId: manifest?.batchId,
    entries: manifest?.entries,
  });
  if (stableStringify(comparable(expected)) !== stableStringify(comparable(actual))) {
    throw new Error("CATEGORY_EDITORIAL_SOURCE_MANIFEST_CHANGED");
  }
}

function productHasCover(existing) {
  const attrs = existing?.attributes ?? existing ?? {};
  const coverRaw = attrs.CoverImage;
  const cover =
    coverRaw && typeof coverRaw === "object" && Object.prototype.hasOwnProperty.call(coverRaw, "data")
      ? coverRaw.data
      : coverRaw;
  return Array.isArray(cover) ? cover.length > 0 : Boolean(cover);
}

function productHasGallery(existing) {
  const attrs = existing?.attributes ?? existing ?? {};
  const galleryRaw = attrs.Media;
  const gallery =
    galleryRaw && typeof galleryRaw === "object" && Object.prototype.hasOwnProperty.call(galleryRaw, "data")
      ? galleryRaw.data
      : galleryRaw;
  return Array.isArray(gallery) ? gallery.length > 0 : Boolean(gallery);
}

/**
 * True when an existing Strapi product already has a usable cover image.
 * Gallery may be empty for single-image WooCommerce products. Used by the
 * `full-sync` preserve policy to skip media re-download when the cover is present.
 *
 * @param {{ attributes?: object } | object} existing index entry
 */
function productHasMedia(existing) {
  return productHasCover(existing);
}

function isRunControlError(error) {
  return error?.code === "CATALOG_RUN_CANCELLED"
    || error?.code === "CATALOG_RUN_PAUSED"
    // The source gate gave up waiting for WooCommerce. Every per-entity catch
    // below records a failure and moves on, which for a dead source would mean
    // re-discovering it once per product for the rest of the run. Abort instead.
    || error?.code === "SOURCE_UNAVAILABLE";
}

function isAbruptCrash(error) {
  return error?.code === "CATALOG_SIMULATED_CRASH";
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

/** @typedef {"create"|"update"|"unchanged"|"manual"|"title-only"} CategoryEditorialDisposition */

/**
 * What this run intends to do with one category's editorial content, decided
 * from the destination snapshot alone. The server re-decides authoritatively
 * inside its own transaction; this is what lets a dry run report the same
 * classification without writing anything.
 *
 * @param {{ titleOnly?: boolean, sourceHash?: string|null, existingEditorial?: any }} plan
 * @returns {CategoryEditorialDisposition}
 */
function categoryEditorialDisposition(plan) {
  const existing = plan.existingEditorial;
  const importerOwned = existing?.importSource === CE.IMPORT_SOURCE;
  if (!existing) return plan.titleOnly ? "title-only" : "create";
  if (!importerOwned) return "manual";
  // An importer-owned row is kept in step with its source even when the source
  // has shrunk to a bare heading — leaving it stale would be worse.
  if (plan.sourceHash && existing.importedSourceHash === plan.sourceHash) return "unchanged";
  return "update";
}

/**
 * Map a disposition onto the report: the shared counters keep their meaning
 * (`created` / `updated` / `unchanged` / `skipped`) and the precise reason is
 * tallied alongside so "skipped" never hides three different decisions.
 */
function recordCategoryEditorialDisposition(report, disposition) {
  const counter = {
    create: "created",
    update: "updated",
    unchanged: "unchanged",
  }[disposition] || "skipped";
  report.count("categoryEditorial", counter);
  report.categoryEditorialOutcome(disposition || "skipped");
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

    // A campaign injects one gate so the catalog branch and the concurrent
    // identity/order stages share a single hold and probe loop — a Woo outage
    // knocks all of them down at the same moment. Standalone CLI runs get their
    // own. Either way the probe uses the *raw* axios instance: routing it back
    // through `wooHttp` would recurse into the gate that is asking.
    const wooAxios = createWooAxios(config);
    const sourceGate = config.sourceGate
      || createSourceGate({
        logger,
        probe: () => wooAxios.request({ method: "get", url: "/products", params: { per_page: 1 } }),
        maxHoldMs: config.catalog.sourceHoldMaxMs,
      });

    const wooHttp = new HttpClient(wooAxios, {
      logger,
      maxRetries: config.catalog.maxRetries,
      baseDelay: config.catalog.baseRetryDelay,
      sourceGate,
    });
    this.sourceGate = sourceGate;
    const strapiHttp = new HttpClient(createStrapiAxios(config), {
      logger,
      maxRetries: config.catalog.maxRetries,
      baseDelay: config.catalog.baseRetryDelay,
    });

    this.woo = new WooSource(wooHttp, { defaultPerPage: config.catalog.perPage, logger });
    this.repo = new StrapiRepo(strapiHttp, logger);
    this.mapping = new MappingStore(config.duplicateTracking.storageDir, { logger });
    this.mediaStore = new MediaMappingStore(config.duplicateTracking.storageDir, { logger });
    this.media = new MediaSync(config, logger, this.mediaStore, {
      allowHttp: config.catalog.allowHttpMedia,
      imageConcurrency: config.catalog.concurrency?.images || 4,
      videoConcurrency: config.catalog.concurrency?.videos || 1,
    });

    this.multiplier = config.import.currency.multiplier || 1;
    this.statusMappings = config.import.statusMappings.product || {};
    this.attributeIndexesPromise = null;
    this.globalAttributeRegistryPromise = null;
  }

  async prepareProductAttributeContext(wcProduct, destinationProductId) {
    if (!this.attributeIndexesPromise) {
      this.attributeIndexesPromise = (async () => {
        await this.repo.preloadAttributes();
        await this.repo.preloadGenericAttributes();
      })();
    }
    await this.attributeIndexesPromise;
    if (!this.globalAttributeRegistryPromise) {
      this.globalAttributeRegistryPromise = this.woo.fetchGlobalAttributeRegistry();
    }
    const registry = await this.globalAttributeRegistryPromise;
    const plan = G.buildProductAttributePlan(wcProduct, registry);
    const productId = Number(destinationProductId);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new Error("A destination product id is required for attribute resolution");
    }
    const synced = await this.repo.syncProductAttributePlan(plan, productId);
    return { plan, resolvedDimensions: synced.resolvedDimensions };
  }

  async preflight() {
    this.logger.info("Checking API connectivity…");
    try {
      await this.woo.http.get("/products", { params: { per_page: 1 } });
      this.logger.info("✓ WooCommerce reachable");
    } catch (error) {
      const status = error.response?.status;
      // Carry a code: `safeErrorCode` in the sync service falls back to
      // `error.name`, so a bare Error here recorded the 2026-09-13 campaign as
      // the useless `last_error_code = 'ERROR'`.
      throw Object.assign(
        new Error(`WooCommerce connectivity failed${status ? ` (HTTP ${status})` : ""}: ${error.message}`),
        { code: error.code === "SOURCE_UNAVAILABLE" ? "SOURCE_UNAVAILABLE" : "SOURCE_PREFLIGHT_FAILED" },
      );
    }
    try {
      await this.repo.http.get("/product-categories", { params: { "pagination[pageSize]": 1 } });
      this.logger.info("✓ Strapi reachable");
    } catch (error) {
      const status = error.response?.status;
      throw Object.assign(
        new Error(`Strapi connectivity failed${status ? ` (HTTP ${status})` : ""}: ${error.message}`),
        { code: "DESTINATION_PREFLIGHT_FAILED" },
      );
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
    let categoryEditorialManifest = opts.categoryEditorialManifest || null;
    let startAfterExternalId = parseOptionalPositiveInt(opts.startAfterExternalId);
    const publication = opts.publication || null;
    const runStore = opts.runStore || null;
    let run = null;
    let lockToken = null;
    let retainCrashLease = false;

    if (runStore && opts.resume) {
      run = runStore.getRun(opts.runId);
      if (!runStore.isResumable(run)) {
        throw new Error(`Catalog run ${run.id} is not resumable (status: ${run.status})`);
      }
      dryRun = Boolean(run.options?.dryRun);
      scope = run.options?.scope || scope;
      skipMedia = Boolean(run.options?.skipMedia);
      categoryEditorialManifest = run.options?.categoryEditorialManifest || null;
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
          categoryEditorialManifest,
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
          resumeChildrenByParent: new Set(),
          resumeStockVariationIds: new Set(),
          memoryPeak: { rss: 0, heapUsed: 0, heapTotal: 0 },
        }
      : null;

    this.logger.info(`Scope: ${scope} → ${JSON.stringify(flags)}`);
    if (runContext) {
      lockToken = runStore.acquireLock(run.id);
      runContext.lockToken = lockToken;
      const current = runStore.getRun(run.id);
      for (const item of Object.values(current.items || {})) {
        if (["failed", "running"].includes(item.status) && item.parentWcId !== undefined && item.parentWcId !== null) {
          runContext.resumeChildrenByParent.add(String(item.parentWcId));
        }
        if (item.entity === "stocks" && ["failed", "running"].includes(item.status) && item.wcId !== undefined) {
          runContext.resumeStockVariationIds.add(String(item.wcId));
        }
      }
      this.activeRunContext = runContext;
      this.media.canStart = () => this.ensureRunCanContinue(runContext);
      this.media.observer = opts.crashHooks || null;
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

    let categorySource = null;
    if (flags.categories) {
      categorySource = await this.syncCategories(
        report,
        dryRun,
        runContext,
        categoryLimit,
        opts.onlyCategoryExternalIds || null,
      );
    }
    if (flags.categoryEditorial) {
      const allCategories = categorySource?.all || await this.woo.fetchAllCategories();
      // `--ids` on a category-editorial-only scope never runs syncCategories, so
      // the narrowing is applied here too; without it a targeted editorial
      // repair would quietly become a full-catalog batch.
      const onlyCategoryExternalIds = opts.onlyCategoryExternalIds
        ? new Set(Array.from(opts.onlyCategoryExternalIds, (value) => String(value)))
        : null;
      const selectedCategories = categorySource?.selected
        || (onlyCategoryExternalIds
          ? allCategories.filter((category) => onlyCategoryExternalIds.has(String(category.id)))
          : allCategories);
      await this.syncCategoryEditorial(report, dryRun, allCategories, selectedCategories, {
        expectedManifest: categoryEditorialManifest,
        requireExpectedManifest:
          !dryRun &&
          scope === "category-editorial" &&
          (this.options.environment || "production") === "production",
      });
    }
    if (needsProductLoop(flags)) {
      await this.syncProducts(report, dryRun, flags, limit, runContext, {
        startAfterExternalId,
        observer: opts.observer || null,
        crashHooks: opts.crashHooks || null,
        onlyExternalIds: opts.onlyExternalIds || null,
        sourceProducts: opts.sourceProducts || null,
        publication,
      });
    }

    if (!dryRun) {
      this.mapping.flush();
      this.mediaStore.flush();
    }

      report.printSummary();
      report.save();
      if (runContext) {
        runStore.finalizeFromReport(
          run.id,
          { ...report.toJSON(), metrics: this.collectMetrics(runContext, report) },
          report.hasFailures() ? "resumable" : "completed",
          lockToken,
        );
      }
      return report;
    } catch (error) {
      if (isAbruptCrash(error)) {
        retainCrashLease = true;
        throw error;
      }
      if (runContext) {
        const status = error.code === "CATALOG_RUN_PAUSED"
          ? "paused"
          : error.code === "CATALOG_RUN_CANCELLED"
            ? "cancelled"
            : "failed";
        runStore.setStatus(run.id, status, {
          currentStep: status,
          lastError: error.message,
        }, lockToken);
      }
      throw error;
    } finally {
      if (runContext && lockToken && !retainCrashLease) {
        runStore.releaseLock(run.id, lockToken);
      }
      this.activeRunContext = null;
    }
  }

  async ensureRunCanContinue(runContext) {
    if (!runContext) return;
    const memory = process.memoryUsage();
    runContext.memoryPeak.rss = Math.max(runContext.memoryPeak.rss, memory.rss);
    runContext.memoryPeak.heapUsed = Math.max(runContext.memoryPeak.heapUsed, memory.heapUsed);
    runContext.memoryPeak.heapTotal = Math.max(runContext.memoryPeak.heapTotal, memory.heapTotal);
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
    return Boolean(runContext?.store.shouldSkipItem(runContext.runId, key, {
      retryFailed: runContext.retryFailed,
    }));
  }

  productResumeMode(runContext, productId) {
    if (!runContext) return "full";
    const item = runContext.store.getItem(runContext.runId, `product:${productId}`);
    if (!item || !["completed", "skipped"].includes(item.status)) return "full";
    if (runContext.retryFailed && runContext.resumeChildrenByParent.has(String(productId))) return "children-only";
    return "skip";
  }

  collectMetrics(runContext, report) {
    const memory = process.memoryUsage();
    const elapsedMinutes = Math.max(report.durationMs() / 60_000, 1 / 60_000);
    const products = report.entities.products.created + report.entities.products.updated;
    return {
      media: this.media.uploader.getStats?.() || {},
      http: { woo: this.woo.http.metrics || {}, destination: this.repo.http.metrics || {} },
      memory: runContext?.memoryPeak || { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
      throughput: { completedProductsPerMinute: products / elapsedMinutes },
      replay: runContext ? { eligibleChildParents: runContext.resumeChildrenByParent.size } : {},
    };
  }

  async syncCategories(
    report,
    dryRun,
    runContext = null,
    limit = Infinity,
    onlyExternalIds = null,
  ) {
    this.logger.info("Phase: categories");
    if (runContext) runContext.store.setCurrentStep(runContext.runId, "categories", {}, runContext.lockToken);
    const wcCategories = await this.woo.fetchAllCategories();
    let sorted = sortCategoriesByHierarchy(wcCategories);
    if (onlyExternalIds) {
      const byId = new Map(wcCategories.map((category) => [String(category.id), category]));
      const selected = new Set(Array.from(onlyExternalIds, (value) => String(value)));
      for (const sourceId of Array.from(selected)) {
        let current = byId.get(sourceId);
        const visited = new Set();
        while (current && Number(current.parent) > 0 && !visited.has(String(current.parent))) {
          visited.add(String(current.parent));
          selected.add(String(current.parent));
          current = byId.get(String(current.parent));
        }
      }
      sorted = sorted.filter((category) => selected.has(String(category.id)));
    }
    sorted = sorted.slice(0, limit);
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
          }, runContext.lockToken);
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
            }, runContext.lockToken);
            runContext.store.syncBoundary(runContext.runId, runContext.lockToken, { mediaStore: this.mediaStore });
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
        const editorial = T.mapCategoryEditorial(wc);
        // Trusted migration runs write editorial through the batch prepare/finalize
        // API. The admin category-editorial routes reject API tokens unless the
        // capability policy understands them, and the retired CRUD fallback 403/405s.
        if (
          editorial &&
          id &&
          process.env.IMPORT_SKIP_CATEGORY_SEO !== "true" &&
          !this.config.migration?.controlToken
        ) {
          try {
            const editorialMode = await this.repo.upsertCategoryEditorial(id, editorial);
            this.logger.info(`📝 category SEO ${editorialMode} — ${wc.name} (${wc.id})`);
          } catch (editorialError) {
            this.logger.warn(
              `⚠️ category SEO failed for ${wc.name} (${wc.id}): ${editorialError.message}`,
            );
          }
        }
        if (runContext) {
          runContext.store.completeItem(runContext.runId, itemKey, {
            mode,
            strapiId: id,
            fingerprint: fingerprint(data),
          }, runContext.lockToken);
          runContext.store.syncBoundary(runContext.runId, runContext.lockToken, { mediaStore: this.mediaStore });
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
          }, runContext.lockToken);
          runContext.store.syncBoundary(runContext.runId, runContext.lockToken, { mediaStore: this.mediaStore });
        }
        this.logger.error(`❌ category ${wc.id} (${wc.name}): ${error.message}`);
      }
    }
    if (!dryRun) this.mapping.flush();
    return { all: wcCategories, selected: sorted };
  }

  async syncCategoryEditorial(
    report,
    dryRun,
    sourceCategories,
    selectedCategories = sourceCategories,
    options = {},
  ) {
    this.logger.info("Phase: category editorial");
    if (!this.config.migration?.controlToken) {
      report.fail("categoryEditorial", {
        wcId: "batch",
        stage: "preflight",
        error: "MIGRATION_CONTROL_TOKEN_REQUIRED",
      });
      return;
    }

    let snapshotRows;
    try {
      snapshotRows = await this.repo.fetchCategoryEditorialSnapshot();
    } catch (error) {
      report.fail("categoryEditorial", { wcId: "batch", stage: "snapshot", error });
      return;
    }
    const destinationIndex = CE.destinationCategoryIndex(snapshotRows);
    const routes = CE.categoryRouteMap(sourceCategories, destinationIndex);
    const plans = [];

    const skippedPlans = [];
    for (const category of selectedCategories) {
      if (!CE.sourceHasDescription(category)) continue;
      try {
        const destination = destinationIndex.get(String(category.id));
        const plan = CE.transformCategoryEditorial(category, destination, routes);
        if (!plan) continue;
        plan.existingEditorial = destination?.editorial || null;
        // "manual" and "title-only" do not depend on the source hash, so they
        // are settled before any audio is fetched. A source description that is
        // only a heading would create a page with a title and nothing under it;
        // it is skipped unless this importer already owns a row for that
        // category, in which case the row is kept in step with the source
        // rather than left stale.
        const disposition = categoryEditorialDisposition(plan);
        if (disposition === "title-only" || disposition === "manual") {
          plan.disposition = disposition;
          skippedPlans.push(plan);
          continue;
        }
        plans.push(plan);
      } catch (error) {
        report.fail("categoryEditorial", {
          wcId: category.id,
          stage: "transform",
          error,
        });
      }
    }

    // One unreachable audio file fails its own category. It no longer aborts
    // the batch, because 45 categories waiting on the 46th is not a safety
    // property — the frozen manifest below is what keeps an apply honest.
    const inspected = [];
    for (const plan of plans) {
      if (!plan.audioUrl) {
        plan.sourceHash = CE.categoryEditorialSourceHash(plan, null);
        inspected.push(plan);
        continue;
      }
      report.categoryAudioCount("expected");
      try {
        const inspection = await this.media.inspectAudioUrl(plan.audioUrl);
        plan.audioInspection = inspection;
        plan.sourceHash = CE.categoryEditorialSourceHash(plan, inspection.sha256);
        report.categoryAudioCount("inspected");
        report.categoryAudioCount("bytes", inspection.bytes);
        inspected.push(plan);
      } catch (error) {
        report.categoryAudioCount("failed");
        report.fail("categoryEditorial", {
          wcId: plan.sourceId,
          stage: "audio-inspect",
          error,
        });
      }
    }
    plans.length = 0;
    plans.push(...inspected);
    // Now that every source hash is known, "unchanged" can be told apart from
    // "update" — the classification the dry run reports and the apply follows.
    for (const plan of plans) plan.disposition = categoryEditorialDisposition(plan);

    const manifest = CE.buildCategoryEditorialManifest(sourceCategories, plans);
    const manifestDir = path.join(
      this.config.catalog.trackingDirAbs,
      "category-editorial-manifests",
    );
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, `${manifest.batchId}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    report.setCategoryEditorialManifest(manifest, manifestPath);

    try {
      if (options.requireExpectedManifest && !options.expectedManifest) {
        throw new Error("CATEGORY_EDITORIAL_EXPECTED_MANIFEST_REQUIRED");
      }
      assertMatchingCategoryEditorialManifest(
        readExpectedCategoryEditorialManifest(options.expectedManifest),
        manifest,
      );
    } catch (error) {
      report.fail("categoryEditorial", {
        wcId: "batch",
        stage: "manifest",
        error,
      });
      return;
    }

    if (dryRun) {
      for (const plan of [...plans, ...skippedPlans]) {
        recordCategoryEditorialDisposition(report, plan.disposition);
        if (plan.audioUrl) report.categoryAudioCount("skipped");
      }
      return;
    }
    for (const plan of skippedPlans) {
      recordCategoryEditorialDisposition(report, plan.disposition);
    }

    // Audio is uploaded for anything that will actually be written — a row
    // being updated needs its (possibly new) audio just as a new row does.
    const writablePlans = plans.filter((plan) => plan.disposition === "create" || plan.disposition === "update");
    for (const plan of writablePlans) {
      if (!plan.audioInspection) continue;
      try {
        plan.audio = await this.media.syncInspectedAudio(
          plan.audioUrl,
          plan.audioInspection,
          plan.title,
        );
        report.categoryAudioCount(plan.audio.status === "uploaded" ? "uploaded" : "reused");
      } catch (error) {
        report.categoryAudioCount("failed");
        plan.audioFailed = true;
        report.fail("categoryEditorial", {
          wcId: plan.sourceId,
          stage: "audio-upload",
          error,
        });
      }
    }

    const finalizeEntries = [];
    for (const plan of plans) {
      const existing = plan.existingEditorial;
      // An audio upload that failed above already counted as a failure for this
      // category; sending it now would write an editorial row without its file.
      if (plan.audioFailed) continue;
      // Every remaining plan goes to the server, which holds the category lock
      // and is the only place the decision can be made without a race. A row
      // that is already published and unchanged simply costs one call and is
      // then left out of finalize, so a clean rerun writes nothing at all.
      try {
        const response = await this.repo.prepareCategoryEditorial({
          batchId: manifest.batchId,
          sourceId: plan.sourceId,
          categoryId: plan.destinationCategoryId,
          sourceHash: plan.sourceHash,
          data: {
            Title: plan.title,
            Paragraph: plan.paragraph,
            Content: plan.content,
            IsRTL: true,
          },
          audio: plan.audio
            ? { id: plan.audio.id, sha256: plan.audio.sha256 }
            : null,
        });
        // The server holds the category lock and re-decides authoritatively;
        // the engine's own classification is only a plan, so the response is
        // what gets reported.
        if (response?.mode === "prepared") {
          recordCategoryEditorialDisposition(report, "create");
        } else if (response?.mode === "updated") {
          // An updated row may already be published; finalize still revalidates
          // its page, because its copy changed even though its state did not.
          recordCategoryEditorialDisposition(report, "update");
        } else if (
          response?.mode === "skipped" &&
          response?.reason === "unchanged" &&
          response?.importedSourceHash === plan.sourceHash
        ) {
          recordCategoryEditorialDisposition(report, "unchanged");
          // Nothing to publish and nothing to revalidate.
          if (response?.isPublished === true) continue;
        } else if (response?.mode === "skipped") {
          recordCategoryEditorialDisposition(report, response.reason || "skipped");
          continue;
        } else {
          throw new Error("CATEGORY_EDITORIAL_PREPARE_RESPONSE_INVALID");
        }
        finalizeEntries.push({
          sourceId: plan.sourceId,
          categoryId: plan.destinationCategoryId,
          editorialId: Number(response.id),
          sourceHash: plan.sourceHash,
          // A row adopted from an interrupted batch keeps the audio that run
          // already uploaded; only a row this run wrote has `plan.audio`.
          audio: plan.audio
            ? { id: plan.audio.id, sha256: plan.audio.sha256 }
            : (plan.audioInspection && existing?.audio?.id
              ? { id: Number(existing.audio.id), sha256: plan.audioInspection.sha256 }
              : null),
        });
      } catch (error) {
        report.fail("categoryEditorial", {
          wcId: plan.sourceId,
          stage: "prepare",
          error,
        });
      }
    }

    // Per-category failures no longer hold back the categories that succeeded;
    // finalize publishes exactly the rows this batch prepared or updated.
    if (finalizeEntries.length === 0) return;
    try {
      const finalized = await this.repo.finalizeCategoryEditorial({
        batchId: manifest.batchId,
        entries: finalizeEntries,
      });
      report.count("categoryEditorial", "successful", Number(finalized?.published || 0));
    } catch (error) {
      report.fail("categoryEditorial", {
        wcId: "batch",
        stage: "finalize",
        error,
      });
    }
  }

  async syncProducts(report, dryRun, flags, limit = Infinity, runContext = null, options = {}) {
    this.logger.info("Phase: products + variations");
    if (runContext) runContext.store.setCurrentStep(runContext.runId, "products", {}, runContext.lockToken);
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
      publication: options.publication || null,
      productIndex: await this.repo.buildExternalIndex("/products", productIndexParams),
      variationIndex: await this.repo.buildExternalIndex("/product-variations"),
      stockIndex: await this.repo.buildExternalIndex("/product-stocks"),
      globalAttributeRegistry:
        flags.variations && flags.variationFields === "all"
          ? await this.woo.fetchGlobalAttributeRegistry()
          : new Map(),
      observer: options.observer || null,
      crashHooks: options.crashHooks || null,
    };

    let processed = 0;
    const onlyExternalIds = options.onlyExternalIds
      ? new Set(Array.from(options.onlyExternalIds, (value) => String(value)))
      : null;
    const sourceProducts = options.sourceProducts || this.woo.iterateProducts();

    // The out-of-stock gate is only sound over a *complete* Woo enumeration
    // whose stockIndex was built for this run. The hourly drain injects a
    // handful of rows (options.sourceProducts) and callers can narrow with
    // onlyExternalIds/--limit; in those cases the caller explicitly asked for
    // those products, so never second-guess them. Dry runs write nothing, so
    // there is nothing to gate.
    ctx.stockGateActive = flags.stockGate === "instock-or-verify"
      && !dryRun
      && !options.sourceProducts
      && !onlyExternalIds
      && !Number.isFinite(limit);
    ctx.stockGateStats = { examined: 0, verifiedSkipped: 0, staleNonZero: 0 };

    const handleProduct = async (wcProduct) => {
      try {
        await this.ensureRunCanContinue(runContext);
        if (onlyExternalIds && !onlyExternalIds.has(String(wcProduct.id))) return;
        if (options.startAfterExternalId && Number(wcProduct.id) <= options.startAfterExternalId) {
          report.count("products", "skipped");
          return;
        }
        if (processed >= limit) return;
        processed += 1;
        report.productDiscovered(1);
        report.productProcessed(1);
        await this.syncOneProduct(wcProduct, ctx);
        if (runContext) {
          runContext.store.syncBoundary(runContext.runId, runContext.lockToken, { mediaStore: this.mediaStore });
        }
      } catch (error) {
        if (isRunControlError(error) || isAbruptCrash(error)) throw error;
        report.fail("products", { wcId: wcProduct.id, stage: "sync-product", error });
        if (runContext) {
          runContext.store.failItem(runContext.runId, `product:${wcProduct.id}`, {
            entity: "products",
            wcId: wcProduct.id,
            stage: "sync-product",
            error,
          }, runContext.lockToken);
          runContext.store.syncBoundary(runContext.runId, runContext.lockToken, { mediaStore: this.mediaStore });
        }
        this.logger.error(`❌ product ${wcProduct.id} (${wcProduct.name}): ${error.message}`);
      }
    };

    const productConcurrency = this.resolveProductConcurrency(flags);
    if (productConcurrency <= 1) {
      // Default path — byte-for-byte the original sequential loop. `break`
      // (rather than handleProduct's approximate `return`) stops pulling
      // further Woo pages the instant `limit` is reached.
      for await (const wcProduct of sourceProducts) {
        if (processed >= limit) break;
        await handleProduct(wcProduct);
      }
    } else {
      // Opt-in path (IMPORT_CONCURRENCY_PRODUCTS > 1, only honored by scopes
      // that don't create shared products/tags/attributes/media — see
      // resolveProductConcurrency). `limit` becomes approximate: up to
      // `productConcurrency - 1` extra products may already be in flight
      // when the cap is reached. Unused by the campaign path (no --limit).
      await mapPoolAsync(sourceProducts, productConcurrency, handleProduct, {
        canStart: () => this.ensureRunCanContinue(runContext),
      });
    }

    if (ctx.stockGateActive) report.setStockGate(ctx.stockGateStats);
  }

  /**
   * Product *parents* are serial by default (see catalog/config.js). Raising
   * IMPORT_CONCURRENCY_PRODUCTS only actually parallelizes scopes that touch
   * neither the shared find-or-create tag/attribute caches
   * (StrapiRepo#productTagCache, #resolveAttributeId) nor the media dedupe
   * store nor `MappingStore#set` — concurrent first-writers there can create
   * duplicate tags/attributes. Every other scope is silently forced back to
   * serial, regardless of the configured value, so a misconfigured env var
   * can't reintroduce that race.
   */
  resolveProductConcurrency(flags) {
    const configured = Math.max(1, Number(this.config.catalog.concurrency?.products) || 1);
    if (configured <= 1) return 1;
    const touchesSharedCaches =
      flags.products || flags.media || flags.variationFields === "all" || flags.categoryEditorial;
    if (touchesSharedCaches) {
      this.logger.info(
        `Product concurrency ${configured} requested but this scope writes products/tags/attributes/media ` +
          "(shared find-or-create caches); forcing serial product processing for correctness.",
      );
      return 1;
    }
    return configured;
  }

  async syncOneProduct(wcProduct, ctx) {
    const { report, dryRun, flags, productIndex, runContext } = ctx;
    const itemKey = `product:${wcProduct.id}`;
    const resumeMode = this.productResumeMode(runContext, wcProduct.id);
    const childrenOnly = resumeMode === "children-only";

    if (resumeMode === "skip" || (!childrenOnly && this.shouldSkipTrackedItem(runContext, itemKey))) {
      report.count("products", "skipped");
      return;
    }

    if (runContext && !childrenOnly) {
      runContext.store.beginItem(runContext.runId, itemKey, {
        entity: "products",
        wcId: wcProduct.id,
        name: wcProduct.name,
        stage: "sync-product",
      }, runContext.lockToken);
    }

    if (!wcProduct.name || wcProduct.name.trim() === "") {
      report.fail("products", { wcId: wcProduct.id, stage: "validate", error: "missing name" });
      if (runContext) {
        runContext.store.failItem(runContext.runId, itemKey, {
          entity: "products",
          wcId: wcProduct.id,
          stage: "validate",
          error: "missing name",
        }, runContext.lockToken);
      }
      return;
    }

    const isSimple =
      wcProduct.type === "simple" ||
      !Array.isArray(wcProduct.variations) ||
      wcProduct.variations.length === 0;

    // --- Out-of-stock gate (scope "inventory-instock") ---
    //
    // Fetching a product's variations is the entire cost of an inventory pass
    // (the "stock" and "price" stages ran at an identical 2.1 products/s
    // precisely because both paid this fetch). Two thirds of the catalog is
    // out of stock, so skipping the fetch for those is the whole speed-up.
    //
    // It must never become a blind zero-out. WooCommerce derives a variable
    // parent's stock_status from wc_product_meta_lookup, which is documented
    // as unreliable in the dangerous direction (real stock reported
    // "outofstock" — woocommerce#26086, #20593, #23645, #28741, #34665).
    // So "outofstock" is only ever treated as *permission to skip*, and only
    // when Strapi independently already holds 0 for every sellable unit:
    // agreeing sources, nothing to write. Any disagreement falls through to
    // the normal path and takes its value from Woo's real stock_quantity.
    if (ctx.stockGateActive && String(wcProduct.stock_status || "") === "outofstock") {
      ctx.stockGateStats.examined += 1;
      const unitIds = isSimple
        ? [String(wcProduct.id)]
        : wcProduct.variations.map((id) => String(id));
      const strapiCounts = unitIds.map((unitId) => {
        const entry = ctx.stockIndex.get(`stock_${unitId}`);
        // Skipping requires Strapi to *independently confirm* zero. A missing
        // row, or a row created earlier in this same run (bare { id }, no
        // attributes), confirms nothing — return null so it reads as unknown
        // and the product takes the normal verified path.
        if (!entry) return null;
        const raw = entry.attributes?.Count ?? entry.Count;
        return raw === undefined || raw === null ? null : Number(raw);
      });
      const allZero = strapiCounts.every((count) => count === 0);
      if (allZero) {
        ctx.stockGateStats.verifiedSkipped += 1;
        report.count("products", "skipped");
        if (runContext && !childrenOnly) {
          runContext.store.completeItem(runContext.runId, itemKey, {
            status: "skipped",
            reason: "outofstock-verified-zero",
          }, runContext.lockToken);
        }
        return;
      }
      ctx.stockGateStats.staleNonZero += 1;
    }

    const wcVariations = isSimple ? [] : await this.woo.fetchAllVariations(wcProduct.id);
    const stockEligibility = T.evaluateProductStockEligibility(wcProduct, wcVariations);
    if (!stockEligibility.eligible) {
      ctx.observer?.onProduct?.({ wcProduct, wcVariations, stockEligibility });
      report.count("products", "skipped");
      if (runContext && !childrenOnly) {
        runContext.store.completeItem(runContext.runId, itemKey, {
          status: "skipped",
          reason: stockEligibility.reason,
          unmanagedVariationIds: stockEligibility.unmanagedVariationIds,
        }, runContext.lockToken);
      }
      return;
    }
    ctx.observer?.onProduct?.({ wcProduct, wcVariations, stockEligibility });
    const attributePlan = G.buildProductAttributePlan(wcProduct, ctx.globalAttributeRegistry);

    const existing = productIndex.get(wcProduct.id.toString());
    const existingPublicationStatus =
      existing?.attributes?.Status ?? existing?.Status ?? "InActive";
    const previousProduct = runContext?.store.getItem(runContext.runId, itemKey);
    let productStrapiId = existing?.id || this.mapping.getStrapiId("products", wcProduct.id) || previousProduct?.strapiId;
    let productFingerprint = null;
    let publicationIntent = null;

    // Product record write (only in scopes that touch products).
    if (flags.products && !childrenOnly) {
      const resolveCategoryId = (wooId) => this.mapping.getStrapiId("categories", wooId);
      const resolveCategoryParent = (wooId) => this.mapping.get("categories", wooId)?.parentWcId ?? null;
      const mappedProduct = T.mapProduct(wcProduct, {
        resolveCategoryId,
        resolveCategoryParent,
        statusMappings: this.statusMappings,
        publication: ctx.publication || this.options.publication || null,
      });
      const { data, sizeGuideMatrix, sourceTimestamps, descriptionResolution } = mappedProduct;
      publicationIntent = mappedProduct.publicationIntent;
      // Which WooCommerce field the body came from, and why — the shop uses
      // both inconsistently, so the distribution is worth reporting on every
      // run rather than reconstructing from the database afterwards.
      report.descriptionResolved(descriptionResolution);
      this.logger.debug?.(
        `📝 product ${wcProduct.id} description ← ${descriptionResolution.source} (${descriptionResolution.reason})`,
      );
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
        const productWriteStarted = process.hrtime.bigint();
        const previousSlug = existing?.attributes?.Slug ?? existing?.Slug ?? null;
        const { id, mode } = await this.repo.upsert({
          endpoint: "/products",
          externalId: wcProduct.id.toString(),
          payload: data,
          index: productIndex,
          sourceTimestamps,
        });
        // When the canonical slug changes (including decode-on-import), keep the
        // prior form as a permanent alias so old sitemap/bookmark URLs 301.
        if (previousSlug && data.Slug && previousSlug !== data.Slug) {
          try {
            await this.repo.ensureProductSlugAlias(previousSlug, id);
          } catch (aliasError) {
            this.logger.warn(
              `⚠️ slug alias ${wcProduct.id} (${previousSlug} → ${data.Slug}): ${aliasError.message}`,
            );
          }
        }
        this.mapping.set("products", wcProduct.id, id, { name: wcProduct.name, slug: data.Slug });
        report.count("products", mode);
        productStrapiId = id;
        ctx.productWriteMs = (ctx.productWriteMs || 0) + Number(process.hrtime.bigint() - productWriteStarted) / 1e6;
        await ctx.crashHooks?.afterProductWrite?.({ wcProduct, productStrapiId: id, mode });

        try {
          const helperMode = await this.repo.syncProductSizeHelper(id, sizeGuideMatrix, sourceTimestamps);
          report.count("sizeHelpers", helperMode);
        } catch (error) {
          report.fail("sizeHelpers", { wcId: wcProduct.id, stage: "sync-size-guide", error });
          this.logger.warn(`⚠️ size guide ${wcProduct.id} (${wcProduct.name}): ${error.message}`);
        }
      }
    } else if (flags.onlyExisting && !productStrapiId) {
      // stock/price/media scopes: skip products that were never imported.
      report.count("products", "skipped");
      if (runContext && !childrenOnly) {
        runContext.store.completeItem(
          runContext.runId,
          itemKey,
          { status: "skipped", reason: "missing-existing-product" },
          runContext.lockToken,
        );
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
    let mediaOutcome = { complete: true, sourceHadNoImages: true, incompleteReason: null };
    if (!childrenOnly && flags.media && !dryRun && productStrapiId && productStrapiId > 0) {
      // "preserve" policy (full-sync): leave existing media untouched when a product
      // already has a cover; otherwise import (new products and products missing a
      // cover get backfilled).
      if (flags.mediaPolicy === "preserve" && existing && productHasMedia(existing)) {
        report.mediaSkippedExisting();
        this.logger.info(`🖼️  media preserved — product ${wcProduct.id} already has cover`);
      } else {
        const mediaResult = await this.media.syncProductMedia(wcProduct);
        const {
          coverId,
          galleryIds,
          counts,
          failures = {},
          failureDetails = [],
          complete: mediaCompleteFlag,
          sourceHadNoImages,
        } = mediaResult;
        const complete =
          mediaCompleteFlag !== undefined
            ? Boolean(mediaCompleteFlag)
            : (counts.failed || 0) === 0;
        report.mediaExpected(counts.expected || 0);
        report.mediaUploaded(counts.uploaded);
        report.mediaReused(counts.reused);
        report.mediaDownloaded(counts.downloaded || 0);
        report.mediaAssociated(counts.associated || 0);
        report.mediaFailed(counts.failed);
        if (sourceHadNoImages) report.mediaSourceHadNone();

        mediaOutcome = {
          complete: Boolean(complete),
          sourceHadNoImages: Boolean(sourceHadNoImages),
          incompleteReason: complete
            ? null
            : (failureDetails[0]?.error || (counts.failed ? "media-import-incomplete" : "media-missing")),
        };

        for (const detail of failureDetails) {
          report.failures.push({
            entity: "products",
            wcId: wcProduct.id,
            stage: `media:${detail.stage || "sync"}`,
            error: detail.error || "media-failed",
            strapiId: productStrapiId,
            sourceImageId: detail.sourceImageId,
            ...(wcProduct.sku ? { sku: wcProduct.sku } : {}),
          });
        }

        const update = {};
        if (coverId) update.CoverImage = coverId;
        if (galleryIds.length > 0 && !(failures.gallery && productHasGallery(existing))) {
          update.Media = galleryIds;
        }
        if (Object.keys(update).length > 0) {
          try {
            await this.repo.http.put(`/products/${productStrapiId}`, { data: update }, {
              headers: sourceTimestampHeaders(wooSourceTimestamps(wcProduct)),
            });
            // Read-back verification of attached relations when we expected media.
            if (counts.expected > 0) {
              const verified = await this.verifyProductMediaRelations(productStrapiId, {
                coverId,
                galleryIds: update.Media || undefined,
              });
              if (!verified.ok) {
                mediaOutcome.complete = false;
                mediaOutcome.incompleteReason = verified.error || "media-relation-verify-failed";
                report.fail("products", {
                  wcId: wcProduct.id,
                  stage: "media:verify",
                  error: mediaOutcome.incompleteReason,
                  strapiId: productStrapiId,
                  sku: wcProduct.sku || undefined,
                });
              }
            }
          } catch (error) {
            mediaOutcome.complete = false;
            mediaOutcome.incompleteReason = error.message || "media-relation-attach-failed";
            report.fail("products", {
              wcId: wcProduct.id,
              stage: "media:attach",
              error: mediaOutcome.incompleteReason,
              strapiId: productStrapiId,
              sku: wcProduct.sku || undefined,
            });
            // Preserve last-known-good: do not clear relations on attach failure.
            this.logger.warn(`⚠️ media attach failed for product ${wcProduct.id}: ${error.message}`);
          }
        } else if (counts.expected > 0) {
          this.logger.warn(
            `⚠️ source had ${counts.expected} media item(s) but none attached for product ${wcProduct.id}`,
          );
        } else if (sourceHadNoImages) {
          this.logger.info(`ℹ️  source product ${wcProduct.id} has no images`);
        }

        // Publication is applied only after the entire content/media/variation
        // pass. New products are created InActive, so incomplete media can never
        // accidentally expose a half-imported product here.
      }
    } else if (!childrenOnly && flags.media === false) {
      report.mediaSkippedIntentionally();
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

    if (
      flags.products &&
      !childrenOnly &&
      !dryRun &&
      productStrapiId &&
      productStrapiId > 0 &&
      publicationIntent
    ) {
      let intended = publicationIntent;
      const mediaIncomplete = flags.media && mediaOutcome?.complete === false;

      if (mediaIncomplete) {
        // Preserve an already-public product's last-known-good media/state. New,
        // inactive, and previously scheduled targets stay unpublished until the
        // retrying control-plane item completes its media step.
        if (existingPublicationStatus === "Active") {
          intended = null;
        } else {
          intended = { action: "unpublish" };
        }
      } else if (
        existingPublicationStatus === "Active" &&
        publicationIntent.action === "schedule"
      ) {
        // Scheduling an update to an already-public product is explicitly out of
        // scope. Never demote the live product to Scheduled.
        this.logger.warn(
          `⚠️ publication schedule skipped for active product ${wcProduct.id}: scheduled-update-unsupported`,
        );
        ctx.publicationIssue = "scheduled-update-unsupported";
        intended = null;
      } else if (publicationIntent.errorCode) {
        this.logger.warn(
          `⚠️ publication mapping issue for product ${wcProduct.id}: ${publicationIntent.errorCode}`,
        );
        ctx.publicationIssue = publicationIntent.errorCode;
        if (existingPublicationStatus === "Active") intended = null;
      }

      if (intended) {
        intended = {
          ...intended,
          requireMedia:
            intended.requireMedia === true &&
            flags.media &&
            mediaOutcome?.sourceHadNoImages !== true,
        };
        try {
          const publicationResult = await this.repo.changeProductPublication(
            productStrapiId,
            wcProduct.id,
            intended,
          );
          this.logger.info(
            `📅 publication ${wcProduct.id}: ${publicationResult?.Status || intended.action}`,
          );
        } catch (error) {
          const status = error.response?.status;
          // The migration API overlay has no publication command route (405).
          // Catalog/product/variation/stock writes already succeeded.
          if (status === 404 || status === 405) {
            this.logger.warn(
              `⚠️ publication endpoint unavailable for product ${wcProduct.id} (HTTP ${status}); catalog row kept`,
            );
            ctx.publicationIssue = `endpoint-${status}`;
          } else {
            throw error;
          }
        }
      }
    }

    if (runContext && !childrenOnly) {
      const incomplete = flags.media && !dryRun && mediaOutcome && mediaOutcome.complete === false;
      if (incomplete) {
        report.count("products", "incomplete");
        runContext.store.failItem(runContext.runId, itemKey, {
          entity: "products",
          wcId: wcProduct.id,
          stage: "media-incomplete",
          error: mediaOutcome.incompleteReason || "media-import-incomplete",
          strapiId: productStrapiId,
        }, runContext.lockToken);
      } else {
        report.count("products", "successful");
        runContext.store.completeItem(runContext.runId, itemKey, {
          strapiId: productStrapiId,
          fingerprint: productFingerprint,
          metrics: {
            productWriteMs: ctx.productWriteMs || 0,
            ...(ctx.publicationIssue ? { publicationIssue: ctx.publicationIssue } : {}),
          },
        }, runContext.lockToken);
      }
    } else if (!childrenOnly) {
      if (flags.media && !dryRun && mediaOutcome && mediaOutcome.complete === false) {
        report.count("products", "incomplete");
      } else if (flags.products) {
        report.count("products", "successful");
      }
    }
  }

  /**
   * Best-effort read-back of CoverImage / Media after attach.
   * @param {number} productStrapiId
   * @param {{ coverId?: number|null, galleryIds?: number[] }} expected
   */
  async verifyProductMediaRelations(productStrapiId, expected) {
    try {
      const response = await this.repo.http.get(`/products/${productStrapiId}`, {
        params: {
          "populate[CoverImage][fields][0]": "id",
          "populate[Media][fields][0]": "id",
        },
      });
      const raw = response?.data?.data || response?.data || response;
      const attrs = raw?.attributes || raw || {};
      const cover = attrs.CoverImage?.data ?? attrs.CoverImage;
      const coverId = Array.isArray(cover) ? cover[0]?.id : cover?.id ?? cover;
      if (expected.coverId && Number(coverId) !== Number(expected.coverId)) {
        return { ok: false, error: `cover-mismatch expected=${expected.coverId} got=${coverId}` };
      }
      if (Array.isArray(expected.galleryIds) && expected.galleryIds.length > 0) {
        const galleryRaw = attrs.Media?.data ?? attrs.Media;
        const gallery = Array.isArray(galleryRaw) ? galleryRaw : galleryRaw ? [galleryRaw] : [];
        const gotIds = gallery.map((entry) => Number(entry?.id ?? entry));
        for (const id of expected.galleryIds) {
          if (!gotIds.includes(Number(id))) {
            return { ok: false, error: `gallery-missing-id=${id}` };
          }
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || "media-verify-request-failed" };
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
      if (ctx.runContext?.store.getItem(ctx.runContext.runId, `variation:${synthetic.id}`)?.status === "failed") {
        const error = new Error(`Variation ${synthetic.id} failed for product ${wcProduct.id}`);
        error.code = "CATALOG_CHILD_FAILED";
        throw error;
      }
      return;
    }

    const results = await mapPoolOrdered(
      prefetchedVariations,
      this.config.catalog.concurrency?.variations || 8,
      async (wcVariation) => {
        try {
          await this.ensureRunCanContinue(ctx.runContext);
          await this.syncOneVariation(wcVariation, wcProduct, parentStrapiId, ctx, attributeContext);
          const tracked = ctx.runContext?.store.getItem(ctx.runContext.runId, `variation:${wcVariation.id}`);
          return { failed: tracked?.status === "failed" };
        } catch (error) {
          if (isRunControlError(error) || isAbruptCrash(error) || error.code === "CATALOG_FENCE_REJECTED") throw error;
          ctx.report.fail("variations", { wcId: wcVariation.id, stage: "sync-variation", error });
          if (ctx.runContext) {
            ctx.runContext.store.failItem(ctx.runContext.runId, `variation:${wcVariation.id}`, {
              entity: "variations",
              wcId: wcVariation.id,
              parentWcId: wcProduct.id,
              stage: "sync-variation",
              error,
            }, ctx.runContext.lockToken);
          }
          this.logger.error(`❌ variation ${wcVariation.id} (parent ${wcProduct.id}): ${error.message}`);
          return { failed: true };
        }
      },
      { canStart: () => this.ensureRunCanContinue(ctx.runContext) },
    );
    if (results.some((result) => result.failed)) {
      const error = new Error(`One or more variations failed for product ${wcProduct.id}`);
      error.code = "CATALOG_CHILD_FAILED";
      throw error;
    }
  }

  async syncOneVariation(wcVariation, parentProduct, parentStrapiId, ctx, attributeContext) {
    const { report, dryRun, flags, variationIndex, stockIndex, runContext } = ctx;
    const externalId = wcVariation.id.toString();
    const itemKey = `variation:${externalId}`;
    const existing = variationIndex.get(externalId);
    const previousVariation = runContext?.store.getItem(runContext.runId, itemKey);
    const stockOnly = Boolean(
      runContext?.retryFailed &&
      ["completed", "skipped"].includes(previousVariation?.status) &&
      runContext.resumeStockVariationIds.has(externalId),
    );

    if (!stockOnly && this.shouldSkipTrackedItem(runContext, itemKey)) {
      report.count("variations", "skipped");
      return;
    }

    if (runContext && !stockOnly) {
      runContext.store.beginItem(runContext.runId, itemKey, {
        entity: "variations",
        wcId: wcVariation.id,
        parentWcId: parentProduct.id,
        stage: "sync-variation",
      }, runContext.lockToken);
    }

    // onlyExisting scopes (stock/price/media) never create new variations.
    if (flags.onlyExisting && !existing) {
      report.count("variations", "skipped");
      if (runContext) {
        runContext.store.completeItem(runContext.runId, itemKey, { status: "skipped", reason: "missing-existing-variation" }, runContext.lockToken);
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
            }, runContext.lockToken);
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
            }, runContext.lockToken);
          }
          return;
        }
        report.count("variations", existing ? "updated" : "created");
      }
      if (flags.stock && (existing || !flags.onlyExisting)) {
        report.count("stocks", existing ? "updated" : "created");
      }
      if (runContext) {
        runContext.store.completeItem(runContext.runId, itemKey, { mode: existing ? "updated" : "created" }, runContext.lockToken);
      }
      return;
    }

    // --- Variation record write ---
    if (flags.variations && !stockOnly) {
      if (flags.variationFields === "price-only") {
        // Update only Price/DiscountPrice on an existing variation; never create.
        if (variationStrapiId) {
          const pricing = T.computeVariationPricing(wcVariation, parentProduct, this.multiplier);
          if (!pricing.priceMissing) {
            const payload = { Price: pricing.price };
            payload.DiscountPrice = pricing.discountPrice ?? null;
            await this.repo.http.put(`/product-variations/${variationStrapiId}`, { data: payload }, {
              headers: sourceTimestampHeaders(wooSourceTimestamps(wcVariation)),
            });
            report.count("variations", "updated");
            variationFingerprint = fingerprint(payload);
          } else {
            report.count("variations", "skipped");
          }
        }
      } else {
        const { data, priceMissing, sourceTimestamps } = T.mapVariation(wcVariation, {
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
            }, runContext.lockToken);
          }
          return;
        }
        await this.attachAttributes(wcVariation, data, attributeContext);
        variationFingerprint = fingerprint(data);
        const variationWriteStarted = process.hrtime.bigint();
        const { id, mode } = await this.repo.upsert({
          endpoint: "/product-variations",
          externalId,
          payload: data,
          index: variationIndex,
          sourceTimestamps,
        });
        this.mapping.set("variations", wcVariation.id, id, { productId: parentProduct.id, sku: data.SKU });
        report.count("variations", mode);
        variationStrapiId = id;
        const relationCheck = await this.verifyVariationAttributeRelations(id, data);
        if (!relationCheck.ok) {
          const error = new Error(
            `Variation attribute persistence failed for ${wcVariation.id}: ${relationCheck.error}`,
          );
          error.code = "VARIATION_ATTRIBUTE_PERSISTENCE_FAILED";
          throw error;
        }
        ctx.variationWriteMs = (ctx.variationWriteMs || 0) + Number(process.hrtime.bigint() - variationWriteStarted) / 1e6;
        await ctx.crashHooks?.afterVariationWrite?.({ wcVariation, variationStrapiId: id, mode });
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
          }, runContext.lockToken);
        }
        const stockWriteStarted = process.hrtime.bigint();
        try {
          const stockMode = await this.repo.upsertStock({
            externalId: stock.externalId,
            count: stock.count,
            variationId: variationStrapiId,
            stockIndex,
            sourceTimestamps: wooSourceTimestamps(wcVariation),
          });
          report.count("stocks", stockMode);
          await ctx.crashHooks?.afterStockWrite?.({ wcVariation, variationStrapiId, stockMode });
          if (runContext) {
            runContext.store.completeItem(runContext.runId, stockKey, {
              mode: stockMode,
              externalId: stock.externalId,
              fingerprint: fingerprint(stock),
              metrics: { writeMs: Number(process.hrtime.bigint() - stockWriteStarted) / 1e6 },
            }, runContext.lockToken);
          }
          await ctx.crashHooks?.afterStockCommitBeforeVariationComplete?.({ wcVariation, variationStrapiId, stockMode });
        } catch (error) {
          if (isAbruptCrash(error)) throw error;
          if (runContext) {
            runContext.store.failItem(runContext.runId, stockKey, {
              entity: "stocks",
              wcId: wcVariation.id,
              parentWcId: parentProduct.id,
              stage: "sync-stock",
              error,
            }, runContext.lockToken);
          }
          throw error;
        }
      }
    }

    if (runContext && !stockOnly) {
      runContext.store.completeItem(runContext.runId, itemKey, {
        strapiId: variationStrapiId,
        fingerprint: variationFingerprint,
        metrics: { writeMs: ctx.variationWriteMs || 0 },
      }, runContext.lockToken);
    }
  }

  /**
   * Compare WooCommerce and Strapi catalogs (read-only). Reports products present
   * in one store but not the other (by external_id). Returns `{ ok, wcOnly, strapiOnly }`.
   *
   * `status` defaults to WooCommerce's own default listing scope. Pass
   * `status: "any"` for reconciliation callers — otherwise a Woo product that's
   * merely draft/pending/private (but already imported, e.g. later unpublished
   * upstream) is invisible to `iterateProducts()` and reads as a false-positive
   * `strapiOnly` "orphan" even though the source product still exists.
   */
  async runVerify({ limit = Infinity, status = null } = {}) {
    await this.preflight();
    this.logger.info("Verify: comparing WooCommerce ↔ Strapi products by external_id");

    const wcIds = new Set();
    let processed = 0;
    for await (const wcProduct of this.woo.iterateProducts(status ? { params: { status } } : {})) {
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
    Object.assign(
      data,
      G.buildVariationAttributePayload(
        wcVariation,
        attributeContext.plan,
        attributeContext.resolvedDimensions,
      ),
    );
  }

  async verifyVariationAttributeRelations(variationId, expected) {
    try {
      const response = await this.repo.http.get(`/product-variations/${variationId}`, {
        params: {
          "fields[0]": "AttributeSignature",
          "populate[product_variation_color][fields][0]": "id",
          "populate[product_variation_size][fields][0]": "id",
          "populate[product_variation_model][fields][0]": "id",
          "populate[selected_attribute_terms][fields][0]": "id",
        },
      });
      const raw = response?.data?.data || response?.data || response;
      const attrs = raw?.attributes || raw || {};
      const relationId = (value) => Number(value?.data?.id ?? value?.id ?? value) || null;
      const relationIds = (value) => {
        const rows = value?.data ?? value ?? [];
        return (Array.isArray(rows) ? rows : [rows])
          .map((row) => Number(row?.id ?? row))
          .filter((id) => Number.isInteger(id) && id > 0)
          .sort((left, right) => left - right);
      };
      const got = {
        product_variation_color: relationId(attrs.product_variation_color),
        product_variation_size: relationId(attrs.product_variation_size),
        product_variation_model: relationId(attrs.product_variation_model),
        selected_attribute_terms: relationIds(attrs.selected_attribute_terms),
        AttributeSignature: String(attrs.AttributeSignature || ""),
      };
      const wanted = {
        product_variation_color: Number(expected.product_variation_color) || null,
        product_variation_size: Number(expected.product_variation_size) || null,
        product_variation_model: Number(expected.product_variation_model) || null,
        selected_attribute_terms: [...(expected.selected_attribute_terms || [])]
          .map(Number)
          .sort((left, right) => left - right),
        AttributeSignature: String(expected.AttributeSignature || ""),
      };
      if (JSON.stringify(got) !== JSON.stringify(wanted)) {
        return { ok: false, error: `expected=${JSON.stringify(wanted)} got=${JSON.stringify(got)}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || "relation-readback-failed" };
    }
  }
}

module.exports = {
  CatalogEngine,
  isRunControlError,
  sortCategoriesByHierarchy,
  productHasMedia,
  productHasCover,
  productHasGallery,
};
