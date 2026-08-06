"use strict";

const crypto = require("node:crypto");
const CatalogT = require("./transforms");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function sourceRevision(product, variation = null) {
  const fields = (row) => row ? {
    id: row.id ?? null,
    parentId: row.parent_id ?? null,
    type: row.type ?? null,
    status: row.status ?? null,
    dateCreatedGmt: row.date_created_gmt ?? null,
    dateModifiedGmt: row.date_modified_gmt ?? null,
    price: row.price ?? null,
    regularPrice: row.regular_price ?? null,
    salePrice: row.sale_price ?? null,
    onSale: row.on_sale ?? null,
    manageStock: row.manage_stock ?? null,
    stockQuantity: row.stock_quantity ?? null,
    stockStatus: row.stock_status ?? null,
    variations: Array.isArray(row.variations) ? row.variations.map(String).sort() : [],
  } : null;
  return sha256({ product: fields(product), variation: fields(variation) });
}

function timestampOrderInvalid(row) {
  const created = new Date(row?.date_created_gmt ? `${row.date_created_gmt}Z` : row?.date_created || "");
  const updated = new Date(row?.date_modified_gmt ? `${row.date_modified_gmt}Z` : row?.date_modified || "");
  return Number.isNaN(created.getTime()) || Number.isNaN(updated.getTime()) || updated < created;
}

function classification(reasonCode, acceptEligible, containment, impact, retryCondition) {
  return { reasonCode, acceptEligible, containment, impact, retryCondition };
}

function classifyLeaf(entry, product, variation) {
  const error = String(entry.error || "");
  if (entry.sourceFetchFailed) {
    return classification(
      "UNCLASSIFIED_SOURCE_FETCH_FAILURE",
      false,
      "none",
      "source revision could not be proven",
      "repeat the read-only audit after source access is healthy",
    );
  }
  if (!variation && ["variations", "stocks"].includes(entry.entity)) {
    return classification(
      "SOURCE_ENTITY_REMOVED",
      true,
      "exclude the missing sellable unit and quarantine dependent orders",
      "the deleted source unit is not present at the destination",
      "source unit is restored or the exception is reconciled manually",
    );
  }
  if (entry.entity === "variations") {
    const pricing = CatalogT.computeVariationPricing(variation, product);
    if (pricing.priceMissing || /no price|price[_ -]?missing/i.test(error)) {
      return classification(
        "MISSING_PRICE",
        true,
        "exclude only this sellable unit and quarantine dependent orders",
        "this variation cannot be sold until a positive source price exists",
        "source receives a positive regular or sale price",
      );
    }
  }
  if (/SOURCE_UPDATED_BEFORE_CREATED/.test(error) && timestampOrderInvalid(variation || product)) {
    return classification(
      "SOURCE_TIMESTAMP_INVALID",
      true,
      "exclude the invalid source record and quarantine dependent orders",
      "historical source timestamps cannot be preserved safely",
      "source created and modified timestamps become valid and ordered",
    );
  }
  if (/\b(400|401|403|409)\b|unauthori[sz]ed|forbidden|duplicate|ambiguous/i.test(error)) {
    return classification(
      "UNCLASSIFIED_DESTINATION_RESPONSE",
      false,
      "none",
      "destination failure is not classified",
      "classify the destination response and prove uniqueness and authorization",
    );
  }
  return classification(
    "UNCLASSIFIED_IMPORT_FAILURE",
    false,
    "none",
    "failure is not safely understood",
    "classify and contain the exact failure",
  );
}

function sortedStrings(values) {
  return Array.from(new Set(Array.from(values || [], String))).sort((a, b) => a.localeCompare(b));
}

function reusableDependencyAudit(previousAudit, failedProductIds, failedSellableIds) {
  if (!previousAudit) return null;
  const previousDependency = previousAudit.dependencyAudit;
  const previousManifest = previousAudit.manifest;
  if (!previousDependency || !previousManifest ||
      previousManifest.dependencyAuditSha256 !== sha256(previousDependency)) {
    throw new Error("Previous exception audit dependency digest is invalid");
  }
  const products = sortedStrings(failedProductIds);
  const sellables = sortedStrings(failedSellableIds);
  if (canonicalJson(sortedStrings(previousDependency.failedProductIds)) !== canonicalJson(products) ||
      canonicalJson(sortedStrings(previousDependency.failedSellableIds)) !== canonicalJson(sellables)) {
    throw new Error("Previous exception audit failure set does not match the current projection");
  }
  const modifiedAfter = new Date(previousAudit.audit?.generatedAt || "");
  if (Number.isNaN(modifiedAfter.getTime())) throw new Error("Previous exception audit has no valid watermark");
  return {
    dependencyAuditSha256: previousManifest.dependencyAuditSha256,
    dependentOrderIds: sortedStrings(previousDependency.dependentOrderIds),
    ordersScanned: Number(previousDependency.ordersScanned || 0),
    modifiedAfter: modifiedAfter.toISOString(),
  };
}

async function buildCatalogExceptionManifest({
  store,
  runId,
  source,
  approvedBy,
  approvalReference,
  previousAudit = null,
}) {
  const audit = store.exceptionAudit(runId);
  const run = store.getRun(runId);
  const productCache = new Map();
  const variationCache = new Map();

  async function loadProduct(id) {
    const key = String(id);
    if (!productCache.has(key)) productCache.set(key, source.getProduct(key));
    return productCache.get(key);
  }

  async function loadVariations(product) {
    const key = String(product.id);
    if (!variationCache.has(key)) {
      variationCache.set(key, (async () => {
        if (product.type === "simple" || !product.variations?.length) {
          return [CatalogT.synthesizeSimpleVariation(product)];
        }
        return source.getProductVariations(key);
      })());
    }
    return variationCache.get(key);
  }

  const enriched = [];
  for (const auditEntry of audit.entries) {
    const item = run.items[auditEntry.key] || {};
    const entry = { ...auditEntry, error: String(item.error || "") };
    let product = null;
    let variation = null;
    try {
      const productId = entry.entity === "products" ? entry.wcId : (entry.parentWcId || entry.wcId);
      product = await loadProduct(productId);
      if (["variations", "stocks"].includes(entry.entity)) {
        variation = (await loadVariations(product)).find((row) => String(row.id) === String(entry.wcId)) || null;
      }
      entry.sourceRevisionSha256 = sourceRevision(product, variation);
    } catch (error) {
      entry.sourceFetchFailed = true;
      entry.sourceRevisionSha256 = sha256({ sourceFetchErrorSha256: sha256(String(error?.message || error)) });
    }
    Object.assign(entry, classifyLeaf(entry, product, variation));
    enriched.push(entry);
  }

  for (const entry of enriched.filter((candidate) => candidate.entity === "products" && !candidate.acceptEligible)) {
    const children = enriched.filter(
      (candidate) => candidate.parentWcId === entry.wcId && ["variations", "stocks"].includes(candidate.entity),
    );
    if (children.length > 0 && children.every((child) => child.acceptEligible)) {
      Object.assign(entry, classification(
        "CHILD_EXCEPTION_ROLLUP",
        true,
        "retain the completed parent write and exclude only accepted child exceptions",
        "the parent remains usable through valid completed children",
        "all child exceptions are resolved",
      ));
    }
  }

  const failedSellableIds = new Set(
    enriched
      .filter((entry) => entry.acceptEligible && ["variations", "stocks"].includes(entry.entity))
      .map((entry) => String(entry.wcId)),
  );
  const failedProductIds = new Set(
    enriched
      .filter((entry) => entry.acceptEligible && entry.entity === "products" && entry.reasonCode !== "CHILD_EXCEPTION_ROLLUP")
      .map((entry) => String(entry.wcId)),
  );
  const previousDependency = reusableDependencyAudit(previousAudit, failedProductIds, failedSellableIds);
  const dependentOrderIdSet = new Set(previousDependency?.dependentOrderIds || []);
  let incrementalOrdersScanned = 0;
  const orderParams = previousDependency ? {
    modified_after: previousDependency.modifiedAfter,
    dates_are_gmt: true,
    orderby: "modified",
    order: "asc",
  } : {};
  for await (const page of source.orders(orderParams)) {
    for (const order of page.rows) {
      incrementalOrdersScanned += 1;
      const dependent = (order.line_items || []).some((line) => {
        const productId = String(line.product_id || "");
        const sellableId = String(Number(line.variation_id) > 0 ? line.variation_id : line.product_id || "");
        return failedProductIds.has(productId) || failedSellableIds.has(sellableId);
      });
      if (dependent) dependentOrderIdSet.add(String(order.id));
    }
  }
  const dependentOrderIds = Array.from(dependentOrderIdSet);
  dependentOrderIds.sort((a, b) => Number(a) - Number(b));
  const ordersScanned = Number(previousDependency?.ordersScanned || 0) + incrementalOrdersScanned;

  const dependencyAudit = {
    version: 1,
    runId: audit.runId,
    projectionSha256: audit.projectionSha256,
    ordersScanned,
    incrementalOrdersScanned,
    ...(previousDependency ? {
      baseDependencyAuditSha256: previousDependency.dependencyAuditSha256,
      modifiedAfter: previousDependency.modifiedAfter,
    } : {}),
    dependentOrderIds,
    failedProductIds: Array.from(failedProductIds).sort(),
    failedSellableIds: Array.from(failedSellableIds).sort(),
  };
  const entries = enriched.map(({ error, sourceFetchFailed, ...entry }) => entry);
  return {
    audit: {
      generatedAt: audit.generatedAt,
      status: audit.status,
      exceptionCount: entries.length,
      acceptEligibleCount: entries.filter((entry) => entry.acceptEligible).length,
      allAcceptEligible: entries.length > 0 && entries.every((entry) => entry.acceptEligible),
      ordersScanned,
      dependentOrderCount: dependentOrderIds.length,
    },
    manifest: {
      version: 1,
      runId: audit.runId,
      projectionSha256: audit.projectionSha256,
      approvedBy: String(approvedBy || ""),
      approvalReference: String(approvalReference || ""),
      dependencyAuditSha256: sha256(dependencyAudit),
      dependentOrderIds,
      entries,
    },
    dependencyAudit,
  };
}

module.exports = {
  buildCatalogExceptionManifest,
  canonicalJson,
  sha256,
  sourceRevision,
  classifyLeaf,
  reusableDependencyAudit,
};
