"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { acceptedCatalogState, catalogCheckpoint, runOrders } = require("../full");

test("accepted catalog state requires a bound non-empty manifest", () => {
  assert.deepEqual(acceptedCatalogState({ status: "completed" }), { accepted: false, manifest: null });
  assert.equal(acceptedCatalogState({ status: "completed-with-exceptions" }), null);
  const run = {
    id: "catalog-1",
    status: "completed-with-exceptions",
    acceptedExceptions: {
      manifestSha256: "a".repeat(64),
      entries: [{ key: "variation:9" }],
      dependentOrderIds: ["22"],
    },
  };
  assert.equal(acceptedCatalogState(run).accepted, true);
  assert.deepEqual(catalogCheckpoint(run), {
    runId: "catalog-1",
    completed: true,
    status: "completed-with-exceptions",
    exceptionManifestSha256: "a".repeat(64),
    exceptionCount: 1,
    dependentOrderCount: 1,
  });
});

test("outer order stage skips only dependency-quarantined orders and continues", async () => {
  const source = {
    async *orders() {
      const order = (id) => ({
        id,
        date_created_gmt: "2026-01-01T00:00:00",
        customer_id: 10,
        status: "processing",
        total: "100",
        shipping_total: "0",
        total_tax: "0",
        line_items: [{ id: id * 10, variation_id: 9, quantity: 1, price: "100", name: "item" }],
      });
      yield { page: 1, rows: [order(21), order(22)] };
    },
  };
  const written = [];
  const destination = {
    async upsertOrder(payload) {
      written.push(payload.sourceId);
      return { mode: "created", itemsCreated: 1, itemsUpdated: 0, itemsDeleted: 0 };
    },
  };
  const counts = [];
  const issues = [];
  const checkpoints = [];
  const ledger = {
    count(entity, outcome, amount = 1) { counts.push([entity, outcome, amount]); },
    issue(entity, sourceId, code) { issues.push([entity, sourceId, code]); },
    failure() { throw new Error("unexpected order failure"); },
    checkpoint(entity, value) { checkpoints.push([entity, value]); },
  };

  await runOrders(source, destination, ledger, 0, 8, new Set(["22"]));

  assert.deepEqual(written, ["21"]);
  assert.deepEqual(issues, [["orders", "22", "CATALOG_DEPENDENCY_QUARANTINED"]]);
  assert.ok(counts.some(([entity, outcome]) => entity === "orders" && outcome === "skipped"));
  assert.deepEqual(checkpoints, [["orders", { page: 1 }]]);
});
