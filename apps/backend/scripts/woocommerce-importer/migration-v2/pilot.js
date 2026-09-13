"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CatalogEngine } = require("../catalog/engine");
const { buildConfig } = require("../catalog/config");
const CatalogT = require("../catalog/lib/transforms");
const Logger = require("../utils/Logger");
const T = require("./lib/transforms");
const { classifyOrderLine, ORDER_LINE_ORPHAN } = require("./lib/orderLines");
const { transformBlogContent } = require("./lib/blogContent");
const { wordpressSourceTimestamps } = require("../utils/sourceTimestamps");
const { loadBlogDestinationIndexes } = require("./dry-run");

function candidateIds(dryRun, kind) {
  return Array.isArray(dryRun?.candidates?.[kind]) ? dryRun.candidates[kind].map(String) : [];
}

function firstCandidates(dryRun, kinds) {
  return Array.from(new Set(kinds.flatMap((kind) => candidateIds(dryRun, kind))));
}

function rawOrderProductIds(order) {
  const ids = new Set();
  for (const line of Array.isArray(order?.line_items) ? order.line_items : []) {
    const reference = classifyOrderLine(line);
    // Orphan lines (product deleted after the sale) carry no catalog dependency
    // for the pilot to inspect; the order transform keeps them as snapshots.
    if (reference.kind === ORDER_LINE_ORPHAN) continue;
    if (!reference.productSourceId) throw new Error("ORDER_ITEM_PRODUCT_REFERENCE_INVALID");
    ids.add(reference.productSourceId);
  }
  return Array.from(ids);
}

async function inspectPilotProduct(source, sourceId, cache) {
  if (cache.has(sourceId)) return cache.get(sourceId);
  const product = await source.getProduct(sourceId);
  const isSimple = product?.type === "simple" || !Array.isArray(product?.variations) || product.variations.length === 0;
  const variations = isSimple ? [] : await source.getProductVariations(sourceId);
  const stockEligibility = CatalogT.evaluateProductStockEligibility(product, variations);
  const variationIds = new Set(
    isSimple ? [String(product.id)] : variations.map((variation) => String(variation.id)),
  );
  const inspected = { product, variations, stockEligibility, variationIds };
  cache.set(sourceId, inspected);
  return inspected;
}

/**
 * Select a small order cohort whose complete catalog and customer dependencies
 * can be imported first. Only redacted source ids and reason codes are persisted.
 */
async function selectRelationAwarePilotOrders(source, options = {}) {
  const maxOrders = Number(options.maxOrders || 4);
  const maxProducts = Number(options.maxProducts || 8);
  const maxScanned = Number(options.maxScanned || 500);
  const selected = [];
  const selectedKinds = new Set();
  const selectedStatuses = new Set();
  const selectedProductIds = new Set();
  const productCache = new Map();
  const rejected = {};
  let scanned = 0;

  const reject = (code) => {
    rejected[code] = Number(rejected[code] || 0) + 1;
  };

  outer: for await (const page of source.orders()) {
    for (const order of page.rows) {
      if (scanned >= maxScanned) break outer;
      scanned += 1;
      try {
        const payload = T.orderPayload(order);
        // The pilot exists to rehearse the catalog relation end to end. An
        // order with a line whose product WooCommerce no longer has cannot
        // rehearse anything, so it is skipped by name rather than failing later
        // under a misleading variation code. The full import still takes it.
        if (Number(payload.orphanLineCount || 0) > 0) {
          reject("ORDER_ITEM_CATALOG_REFERENCE_MISSING");
          continue;
        }
        const kind = payload.customerSourceId ? "registered" : "guest";
        const selectionKey = `${kind}:${payload.status}`;
        const addsRequiredKind = !selectedKinds.has(kind);
        const addsStatus = !selectedStatuses.has(payload.status);
        if (!addsRequiredKind && !addsStatus) continue;

        if (payload.customerSourceId) {
          const customer = await source.getCustomer(payload.customerSourceId);
          T.customerPayload(customer);
        }

        const productIds = rawOrderProductIds(order);
        const nextProductIds = new Set([...selectedProductIds, ...productIds]);
        if (nextProductIds.size > maxProducts) {
          reject("PILOT_PRODUCT_LIMIT_EXCEEDED");
          continue;
        }

        const availableVariationIds = new Set();
        let productsEligible = true;
        for (const productId of productIds) {
          const inspected = await inspectPilotProduct(source, productId, productCache);
          if (!inspected.stockEligibility.eligible) {
            productsEligible = false;
            break;
          }
          for (const variationId of inspected.variationIds) availableVariationIds.add(variationId);
        }
        if (!productsEligible) {
          reject("ORDER_ITEM_PRODUCT_SKIPPED_UNMANAGED_STOCK");
          continue;
        }
        if (payload.items.some((item) => !availableVariationIds.has(item.variationSourceId))) {
          reject("ORDER_ITEM_VARIATION_NOT_IN_PRODUCT");
          continue;
        }

        productIds.forEach((id) => selectedProductIds.add(id));
        selectedKinds.add(kind);
        selectedStatuses.add(payload.status);
        selected.push({
          sourceId: payload.sourceId,
          kind,
          status: payload.status,
          customerSourceId: payload.customerSourceId,
          productIds,
          selectionKey,
        });
        if (selected.length >= maxOrders && selectedKinds.has("registered") && selectedKinds.has("guest")) {
          break outer;
        }
      } catch (error) {
        reject(error.message || "PILOT_ORDER_SELECTION_FAILED");
      }
    }
  }

  if (!selectedKinds.has("registered") || !selectedKinds.has("guest")) {
    throw new Error("PILOT_ORDER_COHORT_MISSING_GUEST_OR_REGISTERED");
  }
  return {
    scanned,
    orders: selected,
    productIds: Array.from(selectedProductIds),
    rejected,
  };
}

async function loadPilotCategoryIds(source, productIds) {
  const categoryIds = new Set();
  for (const productId of productIds) {
    const product = await source.getProduct(productId);
    for (const category of Array.isArray(product?.categories) ? product.categories : []) {
      if (Number(category?.id) > 0) categoryIds.add(String(category.id));
    }
  }
  return Array.from(categoryIds);
}

async function runCatalogPilot(config, ledger, productIds, categoryIds) {
  const trackingDir = path.join(config.stateDir, "catalog");
  fs.mkdirSync(trackingDir, { recursive: true, mode: 0o700 });
  const { config: catalogConfig } = buildConfig("production");
  catalogConfig.duplicateTracking.storageDir = trackingDir;
  catalogConfig.catalog.trackingDirAbs = trackingDir;
  const logger = new Logger({ ...catalogConfig.logging, level: "info" });
  const validationEngine = new CatalogEngine(catalogConfig, logger, { environment: "production" });
  const validationReport = await validationEngine.runSync({
    dryRun: true,
    scope: "full",
    onlyExternalIds: new Set(productIds),
    onlyCategoryExternalIds: new Set(categoryIds),
  });
  ledger.summary.catalogPilotValidation = validationReport.toJSON();
  ledger.persist();
  if (validationReport.hasFailures()) throw new Error("CATALOG_PILOT_PREFLIGHT_FAILED");

  const writeEngine = new CatalogEngine(catalogConfig, logger, { environment: "production" });
  const report = await writeEngine.runSync({
    dryRun: false,
    scope: "full",
    onlyExternalIds: new Set(productIds),
    onlyCategoryExternalIds: new Set(categoryIds),
  });
  ledger.summary.catalogPilot = report.toJSON();
  if (report.hasFailures()) throw new Error("CATALOG_PILOT_FAILED");
}

async function upsertPilotUser(source, destination, ledger, sourceId) {
  ledger.count("users", "source");
  try {
    const customer = await source.getCustomer(sourceId);
    const payload = T.customerPayload(customer);
    const result = await destination.upsertUser(payload);
    ledger.count("users", "eligible");
    ledger.count("users", result.mode === "created" ? "inserted" : "updated");
    ledger.event("item", { entity: "users", sourceId: String(sourceId), mode: result.mode, destinationId: result.id });
    return { ...result, phone: payload.phone };
  } catch (error) {
    ledger.failure("users", sourceId, error?.payload?.error || error.message);
    return null;
  }
}

async function upsertPilotWallet(source, destination, ledger, sourceId) {
  ledger.count("wallets", "source");
  try {
    const response = await source.getWalletBalance(sourceId);
    const walletUser = {
      id: sourceId,
      balance: T.walletBalanceValue(response),
    };
    const result = await destination.upsertWallet(T.walletPayload(walletUser));
    ledger.count("wallets", "eligible");
    ledger.count("wallets", result.mode === "created" ? "inserted" : "updated");
    ledger.event("item", { entity: "wallets", sourceId: String(sourceId), mode: result.mode, destinationId: result.id });
  } catch (error) {
    ledger.failure("wallets", sourceId, error?.payload?.error || error.message);
  }
}

async function ensureBlogDependencies(source, destination, indexes, ledger, payload) {
  const categoryIds = [];
  for (const sourceId of payload.categoryIds.slice(0, 1)) {
    const sourceCategory = await source.getBlogCategory(sourceId);
    const slug = String(sourceCategory.slug || "").trim();
    const existing = indexes.blogCategoriesBySlug.map.get(slug);
    const result = await destination.contentUpsert("/blog-categories", existing?.id, {
      Title: String(sourceCategory.name || "").trim().slice(0, 100),
      Slug: slug.slice(0, 150),
      Description: String(sourceCategory.description || "").trim().slice(0, 500),
    }, wordpressSourceTimestamps(sourceCategory));
    indexes.blogCategoriesBySlug.map.set(slug, { id: result.id, Slug: slug });
    categoryIds.push(result.id);
    ledger.count("blogCategories", result.mode === "created" ? "inserted" : "updated");
  }

  const tagIds = [];
  for (const sourceId of payload.tagIds) {
    const sourceTag = await source.getBlogTag(sourceId);
    const slug = String(sourceTag.slug || "").trim();
    const existing = indexes.blogTagsBySlug.map.get(slug);
    const result = await destination.contentUpsert("/blog-tags", existing?.id, {
      Name: String(sourceTag.name || "").trim().slice(0, 50),
      Slug: slug.slice(0, 150),
      Description: String(sourceTag.description || "").trim().slice(0, 200),
    }, wordpressSourceTimestamps(sourceTag));
    indexes.blogTagsBySlug.map.set(slug, { id: result.id, Slug: slug });
    tagIds.push(result.id);
    ledger.count("blogTags", result.mode === "created" ? "inserted" : "updated");
  }

  let authorId = null;
  if (payload.authorId) {
    const sourceAuthor = await source.getBlogAuthor(payload.authorId);
    const name = String(sourceAuthor.name || "").trim().slice(0, 100);
    const existing = indexes.blogAuthorsByName.map.get(name);
    if (indexes.blogAuthorsByName.duplicates.has(name)) throw new Error("BLOG_AUTHOR_DESTINATION_AMBIGUOUS");
    const result = await destination.contentUpsert("/blog-authors", existing?.id, {
      Name: name,
      Email: String(sourceAuthor.email || "").trim().toLowerCase() || null,
      Bio: String(sourceAuthor.description || "").trim().slice(0, 1000),
    }, wordpressSourceTimestamps(sourceAuthor));
    indexes.blogAuthorsByName.map.set(name, { id: result.id, Name: name });
    authorId = result.id;
    ledger.count("blogAuthors", result.mode === "created" ? "inserted" : "updated");
  }
  return { categoryId: categoryIds[0] || null, tagIds, authorId };
}

/**
 * Upload one promotional illustration per unique source URL, reusing what an
 * earlier post already uploaded. Returns the destination-relative URL the
 * marker embeds.
 */
function blogImageUploader(destination, ledger) {
  return async (sourceUrl, alt) => {
    ledger.summary.mappings ||= {};
    ledger.summary.mappings.blogMedia ||= {};
    const cache = ledger.summary.mappings.blogMedia;
    const key = `url:${sourceUrl}`;
    if (cache[key]) return cache[key];
    try {
      const uploaded = await destination.uploadBlogMedia(sourceUrl, `promo-${Date.now()}`);
      if (!uploaded?.url) throw new Error("BLOG_MEDIA_URL_MISSING");
      const value = { id: uploaded.id, url: uploaded.url, alt: String(alt || "") };
      cache[key] = value;
      ledger.count("blogMedia", "inserted");
      ledger.summary.metrics.mediaBytes = Number(ledger.summary.metrics.mediaBytes || 0) + uploaded.bytes;
      return value;
    } catch {
      return null;
    }
  };
}

async function upsertPilotBlog(source, destination, indexes, ledger, sourceId, options = {}) {
  ledger.count("blogPosts", "source");
  try {
    const sourcePost = await source.getPost(sourceId);
    // The product carousel only exists in the view-context rendering; without
    // it the article imports with the carousel silently missing.
    const viewPost = await source.getPostView(sourceId).catch(() => null);
    const transformed = await transformBlogContent(
      {
        raw: sourcePost?.content?.raw || "",
        renderedEdit: sourcePost?.content?.rendered || "",
        renderedView: viewPost?.content?.rendered || "",
      },
      {
        resolveCategoryRoute: options.resolveCategoryRoute || null,
        uploadImage: blogImageUploader(destination, ledger),
      },
    );
    for (const diagnostic of transformed.diagnostics) {
      ledger.issue("blogPosts", sourceId, diagnostic);
    }
    const payload = T.blogPostPayload(sourcePost, { content: transformed.content });
    const relations = await ensureBlogDependencies(source, destination, indexes, ledger, payload);
    let featuredImageId = null;
    if (payload.featuredMediaId) {
      ledger.summary.mappings ||= {};
      ledger.summary.mappings.blogMedia ||= {};
      featuredImageId = ledger.summary.mappings.blogMedia[payload.featuredMediaId] || null;
      if (!featuredImageId) {
        const media = await source.getMedia(payload.featuredMediaId);
        const sourceUrl = media?.source_url;
        if (!sourceUrl) throw new Error("BLOG_MEDIA_SOURCE_URL_MISSING");
        const uploaded = await destination.uploadBlogMedia(
          sourceUrl,
          payload.featuredMediaId,
          wordpressSourceTimestamps(media),
        );
        featuredImageId = uploaded.id;
        ledger.summary.mappings.blogMedia[payload.featuredMediaId] = featuredImageId;
        ledger.summary.metrics.mediaBytes = Number(ledger.summary.metrics.mediaBytes || 0) + uploaded.bytes;
        ledger.count("blogMedia", "inserted");
        ledger.persist();
      }
    }
    const existing = indexes.blogPostsBySlug.map.get(payload.data.Slug);
    const result = await destination.contentUpsert("/blog-posts", existing?.id, {
      ...payload.data,
      blog_category: relations.categoryId,
      blog_tags: relations.tagIds,
      blog_author: relations.authorId,
      FeaturedImage: featuredImageId,
    }, payload.sourceTimestamps);
    indexes.blogPostsBySlug.map.set(payload.data.Slug, { id: result.id, Slug: payload.data.Slug });
    ledger.count("blogPosts", "eligible");
    ledger.count("blogPosts", result.mode === "created" ? "inserted" : "updated");
    ledger.event("item", { entity: "blogPosts", sourceId: String(sourceId), mode: result.mode, destinationId: result.id });
  } catch (error) {
    ledger.failure("blogPosts", sourceId, error?.payload?.error || error.message);
  }
}

async function upsertPilotOrder(
  source,
  destination,
  ledger,
  sourceId,
  importedUsers,
) {
  ledger.count("orders", "source");
  try {
    const sourceOrder = await source.getOrder(sourceId);
    const payload = T.orderPayload(sourceOrder);
    if (payload.customerSourceId && !importedUsers.has(payload.customerSourceId)) {
      const user = await upsertPilotUser(source, destination, ledger, payload.customerSourceId);
      if (!user) throw new Error("ORDER_PILOT_CUSTOMER_FAILED");
      importedUsers.add(payload.customerSourceId);
    }
    const result = await destination.upsertOrder(payload);
    ledger.count("orders", "eligible");
    ledger.count("orders", result.mode === "created" ? "inserted" : "updated");
    ledger.count("orderItems", "inserted", Number(result.itemsCreated || 0));
    ledger.count("orderItems", "updated", Number(result.itemsUpdated || 0));
    ledger.count("orderItems", "skipped", Number(result.itemsDeleted || 0));
    ledger.event("item", {
      entity: "orders",
      sourceId: String(sourceId),
      mode: result.mode,
      destinationId: result.id,
      userLinked: Boolean(result.userLinked),
    });
  } catch (error) {
    ledger.failure("orders", sourceId, error?.payload?.error || error.message);
  }
}

async function runPilot({ config, source, destination, ledger, dryRun }) {
  ledger.summary.sourceDryRunId = dryRun.runId;
  const orderSelection = await selectRelationAwarePilotOrders(source);
  const productIds = Array.from(new Set([
    ...orderSelection.productIds,
    ...candidateIds(dryRun, "products"),
  ])).slice(0, 8);
  if (productIds.length === 0) throw new Error("PILOT_PRODUCTS_NOT_SELECTED");
  const categoryIds = await loadPilotCategoryIds(source, productIds);
  ledger.summary.pilotSelection = {
    orderRowsScanned: orderSelection.scanned,
    orders: orderSelection.orders,
    productIds,
    categoryIds,
    rejected: orderSelection.rejected,
  };
  ledger.persist();
  await runCatalogPilot(config, ledger, productIds, categoryIds);

  const importedUsers = new Set();
  const walletIds = firstCandidates(dryRun, ["walletZero", "walletNonZero"]).slice(0, 2);
  const orderUserIds = orderSelection.orders
    .map((order) => order.customerSourceId)
    .filter(Boolean);
  const userIds = Array.from(new Set([
    ...firstCandidates(dryRun, ["userInsert", "walletZero", "walletNonZero"]),
    ...orderUserIds,
  ]));
  ledger.summary.pilotSelection.userIds = userIds;
  ledger.summary.pilotSelection.walletIds = walletIds;
  ledger.persist();
  for (const sourceId of userIds) {
    const result = await upsertPilotUser(source, destination, ledger, sourceId);
    if (result) importedUsers.add(String(sourceId));
  }
  for (const sourceId of walletIds) await upsertPilotWallet(source, destination, ledger, sourceId);

  const indexes = await loadBlogDestinationIndexes(destination);
  for (const sourceId of candidateIds(dryRun, "blogPosts").slice(0, 5)) {
    await upsertPilotBlog(source, destination, indexes, ledger, sourceId);
  }
  for (const selectedOrder of orderSelection.orders) {
    await upsertPilotOrder(
      source,
      destination,
      ledger,
      selectedOrder.sourceId,
      importedUsers,
    );
  }
  ledger.summary.metrics.source = source.metrics();
  ledger.summary.metrics.destination = destination.metrics();
  ledger.persist();
  return ledger.summary;
}

module.exports = {
  runPilot,
  runCatalogPilot,
  upsertPilotUser,
  upsertPilotWallet,
  upsertPilotBlog,
  upsertPilotOrder,
  loadPilotCategoryIds,
  selectRelationAwarePilotOrders,
};
