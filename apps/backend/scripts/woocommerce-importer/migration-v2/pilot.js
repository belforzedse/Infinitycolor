"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CatalogEngine } = require("../catalog/engine");
const { buildConfig } = require("../catalog/config");
const Logger = require("../utils/Logger");
const T = require("./lib/transforms");
const { loadBlogDestinationIndexes } = require("./dry-run");

function candidateIds(dryRun, kind) {
  return Array.isArray(dryRun?.candidates?.[kind]) ? dryRun.candidates[kind].map(String) : [];
}

function firstCandidates(dryRun, kinds) {
  return Array.from(new Set(kinds.flatMap((kind) => candidateIds(dryRun, kind))));
}

async function runCatalogPilot(config, ledger, productIds) {
  const trackingDir = path.join(config.stateDir, "catalog");
  fs.mkdirSync(trackingDir, { recursive: true, mode: 0o700 });
  const { config: catalogConfig } = buildConfig("production");
  catalogConfig.duplicateTracking.storageDir = trackingDir;
  catalogConfig.catalog.trackingDirAbs = trackingDir;
  const logger = new Logger({ ...catalogConfig.logging, level: "info" });
  const engine = new CatalogEngine(catalogConfig, logger, { environment: "production" });
  const report = await engine.runSync({
    dryRun: false,
    scope: "full",
    onlyExternalIds: new Set(productIds),
  });
  ledger.summary.catalogPilot = report.toJSON();
  if (report.hasFailures()) throw new Error("CATALOG_PILOT_FAILED");
}

async function upsertPilotUser(source, destination, ledger, sourceId) {
  ledger.count("users", "source");
  try {
    const customer = await source.getCustomer(sourceId);
    const result = await destination.upsertUser(T.customerPayload(customer));
    ledger.count("users", "eligible");
    ledger.count("users", result.mode === "created" ? "inserted" : "updated");
    ledger.event("item", { entity: "users", sourceId: String(sourceId), mode: result.mode, destinationId: result.id });
    return result;
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
    });
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
    });
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
    });
    indexes.blogAuthorsByName.map.set(name, { id: result.id, Name: name });
    authorId = result.id;
    ledger.count("blogAuthors", result.mode === "created" ? "inserted" : "updated");
  }
  return { categoryId: categoryIds[0] || null, tagIds, authorId };
}

async function upsertPilotBlog(source, destination, indexes, ledger, sourceId) {
  ledger.count("blogPosts", "source");
  try {
    const sourcePost = await source.getPost(sourceId);
    const payload = T.blogPostPayload(sourcePost);
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
        const uploaded = await destination.uploadBlogMedia(sourceUrl, payload.featuredMediaId);
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
    });
    indexes.blogPostsBySlug.map.set(payload.data.Slug, { id: result.id, Slug: payload.data.Slug });
    ledger.count("blogPosts", "eligible");
    ledger.count("blogPosts", result.mode === "created" ? "inserted" : "updated");
    ledger.event("item", { entity: "blogPosts", sourceId: String(sourceId), mode: result.mode, destinationId: result.id });
  } catch (error) {
    ledger.failure("blogPosts", sourceId, error?.payload?.error || error.message);
  }
}

async function upsertPilotOrder(source, destination, ledger, sourceId, importedUsers) {
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
    ledger.event("item", { entity: "orders", sourceId: String(sourceId), mode: result.mode, destinationId: result.id });
  } catch (error) {
    ledger.failure("orders", sourceId, error?.payload?.error || error.message);
  }
}

async function runPilot({ config, source, destination, ledger, dryRun }) {
  ledger.summary.sourceDryRunId = dryRun.runId;
  const productIds = candidateIds(dryRun, "products").slice(0, 8);
  if (productIds.length === 0) throw new Error("PILOT_PRODUCTS_NOT_SELECTED");
  await runCatalogPilot(config, ledger, productIds);

  const importedUsers = new Set();
  const walletIds = firstCandidates(dryRun, ["walletZero", "walletNonZero"]).slice(0, 2);
  const userIds = firstCandidates(dryRun, ["userInsert", "walletZero", "walletNonZero"]);
  for (const sourceId of userIds) {
    const result = await upsertPilotUser(source, destination, ledger, sourceId);
    if (result) importedUsers.add(String(sourceId));
  }
  for (const sourceId of walletIds) await upsertPilotWallet(source, destination, ledger, sourceId);

  const indexes = await loadBlogDestinationIndexes(destination);
  for (const sourceId of candidateIds(dryRun, "blogPosts").slice(0, 5)) {
    await upsertPilotBlog(source, destination, indexes, ledger, sourceId);
  }
  for (const sourceId of candidateIds(dryRun, "orders").slice(0, 8)) {
    await upsertPilotOrder(source, destination, ledger, sourceId, importedUsers);
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
};
