"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  selectRelationAwarePilotOrders,
  upsertPilotOrder,
} = require("../pilot");
const { RunLedger } = require("../lib/ledger");

function order({ id, customerId, productId, variationId = 0, status = "processing", phone }) {
  return {
    id,
    customer_id: customerId,
    date_created: "2026-01-01T00:00:00",
    status,
    total: "10",
    shipping_total: "0",
    billing: { phone, first_name: "First", last_name: "Last" },
    line_items: [{
      id: id * 10,
      quantity: 1,
      product_id: productId,
      variation_id: variationId,
      price: "10",
      name: `product-${productId}`,
    }],
  };
}

test("relation-aware pilot selection includes valid registered and guest orders with product dependencies", async () => {
  const rows = [
    order({ id: 1, customerId: 0, productId: 0 }),
    order({ id: 2, customerId: 50, productId: 10, status: "completed" }),
    order({ id: 3, customerId: 0, productId: 20, variationId: 201, phone: "09120000003" }),
  ];
  const source = {
    async *orders() { yield { page: 1, rows }; },
    async getCustomer() {
      return { id: 50, billing: { phone: "09120000050" } };
    },
    async getProduct(id) {
      if (String(id) === "10") {
        return { id: 10, type: "simple", variations: [], manage_stock: true };
      }
      return { id: 20, type: "variable", variations: [201] };
    },
    async getProductVariations(id) {
      assert.equal(String(id), "20");
      return [{ id: 201, manage_stock: true }];
    },
  };

  const result = await selectRelationAwarePilotOrders(source, { maxOrders: 2 });
  assert.deepEqual(result.orders.map((row) => [row.sourceId, row.kind]), [
    ["2", "registered"],
    ["3", "guest"],
  ]);
  assert.deepEqual(result.productIds, ["10", "20"]);
  assert.equal(result.rejected.ORDER_ITEM_PRODUCT_REFERENCE_INVALID, 1);
});

test("pilot order preserves guest identity for canonical destination reconciliation", async () => {
  let written;
  const source = {
    async getOrder() {
      return order({ id: 4, customerId: 0, productId: 10, phone: "09120000004" });
    },
  };
  const destination = {
    async upsertOrder(payload) {
      written = payload;
      return { mode: "created", id: 40, itemsCreated: 1 };
    },
  };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-pilot-order-"));
  const ledger = new RunLedger(stateDir, "pilot", "pilot-order").start();
  try {
    await upsertPilotOrder(source, destination, ledger, "4", new Set());
    assert.equal(written.guestPhone, "+989120000004");
    assert.equal(written.guestIdentity.firstName, "First");
    assert.equal(ledger.summary.entities.orders.inserted, 1);
  } finally {
    ledger.release();
  }
});
