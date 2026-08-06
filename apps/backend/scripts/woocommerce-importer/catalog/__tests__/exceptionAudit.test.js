"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildCatalogExceptionManifest } = require("../lib/exceptionAudit");

test("read-only exception audit classifies missing prices, parent rollups, and order dependencies", async () => {
  const items = {
    "product:1": { entity: "products", wcId: 1, status: "failed", error: "child variation failed" },
    "variation:2": {
      entity: "variations", wcId: 2, parentWcId: 1, status: "failed", error: "no price in WooCommerce",
    },
    "product:3": { entity: "products", wcId: 3, status: "failed", error: "Request failed with status code 400" },
  };
  const auditEntries = Object.entries(items).map(([key, item]) => ({
    key,
    entity: item.entity,
    wcId: String(item.wcId),
    parentWcId: item.parentWcId ? String(item.parentWcId) : null,
    stage: "sync",
    errorSha256: key.padEnd(64, "0").slice(0, 64),
    sourceRevisionSha256: null,
  }));
  const store = {
    exceptionAudit() {
      return {
        runId: "catalog-1",
        projectionSha256: "a".repeat(64),
        generatedAt: "2026-08-05T00:00:00.000Z",
        status: "resumable",
        entries: auditEntries,
      };
    },
    getRun() { return { items }; },
  };
  const products = {
    1: { id: 1, type: "variable", variations: [2], date_created_gmt: "2026-01-01T00:00:00", date_modified_gmt: "2026-01-02T00:00:00" },
    3: { id: 3, type: "simple", price: "10", regular_price: "10", manage_stock: true, stock_quantity: 1 },
  };
  const source = {
    async getProduct(id) { return products[id]; },
    async getProductVariations() {
      return [{ id: 2, parent_id: 1, regular_price: "", sale_price: "", manage_stock: true, stock_quantity: 1 }];
    },
    async *orders() {
      yield {
        page: 1,
        rows: [
          { id: 9, line_items: [{ product_id: 1, variation_id: 2 }] },
          { id: 10, line_items: [{ product_id: 3, variation_id: 0 }] },
        ],
      };
    },
  };

  const result = await buildCatalogExceptionManifest({
    store,
    runId: "catalog-1",
    source,
    approvedBy: "operator",
    approvalReference: "incident",
  });
  const byKey = new Map(result.manifest.entries.map((entry) => [entry.key, entry]));
  assert.equal(byKey.get("variation:2").reasonCode, "MISSING_PRICE");
  assert.equal(byKey.get("variation:2").acceptEligible, true);
  assert.equal(byKey.get("product:1").reasonCode, "CHILD_EXCEPTION_ROLLUP");
  assert.equal(byKey.get("product:1").acceptEligible, true);
  assert.equal(byKey.get("product:3").reasonCode, "UNCLASSIFIED_DESTINATION_RESPONSE");
  assert.equal(byKey.get("product:3").acceptEligible, false);
  assert.deepEqual(result.manifest.dependentOrderIds, ["9"]);
  assert.equal(result.audit.ordersScanned, 2);
  assert.equal(result.audit.allAcceptEligible, false);

  const incrementalCalls = [];
  const incrementalSource = {
    ...source,
    async *orders(params) {
      incrementalCalls.push(params);
      yield { page: 1, rows: [{ id: 11, line_items: [{ product_id: 1, variation_id: 2 }] }] };
    },
  };
  const incremental = await buildCatalogExceptionManifest({
    store,
    runId: "catalog-1",
    source: incrementalSource,
    approvedBy: "operator",
    approvalReference: "incident-retry",
    previousAudit: result,
  });
  assert.equal(incrementalCalls[0].modified_after, result.audit.generatedAt);
  assert.equal(incrementalCalls[0].dates_are_gmt, true);
  assert.deepEqual(incremental.manifest.dependentOrderIds, ["9", "11"]);
  assert.equal(incremental.dependencyAudit.incrementalOrdersScanned, 1);
  assert.equal(incremental.dependencyAudit.ordersScanned, 3);
  assert.equal(incremental.dependencyAudit.baseDependencyAuditSha256, result.manifest.dependencyAuditSha256);

  await assert.rejects(
    () => buildCatalogExceptionManifest({
      store,
      runId: "catalog-1",
      source: incrementalSource,
      approvedBy: "operator",
      approvalReference: "incident-retry",
      previousAudit: {
        ...result,
        dependencyAudit: { ...result.dependencyAudit, failedSellableIds: ["different"] },
      },
    }),
    /dependency digest is invalid/,
  );
});
