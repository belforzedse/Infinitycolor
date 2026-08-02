"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RunLedger } = require("../lib/ledger");
const { runReconcile } = require("../reconcile");

async function runProductReconciliation({ destinationTitle, expectedFailures = 0 }) {
  const sourceProduct = {
    id: 44,
    name: "کیف A001",
    slug: "bag-a001",
    meta_data: [{ key: "product_size_guide", value: [["SIZE", "M"]] }],
  };
  const source = {
    async getProduct() { return sourceProduct; },
    metrics() { return {}; },
  };
  const destination = {
    async loadSnapshot(entity) {
      if (entity === "products") {
        return [{ id: 7, external_source: "woocommerce", external_id: "44" }];
      }
      return [];
    },
    async getContent(endpoint, query) {
      assert.equal(endpoint, "/product-variations");
      assert.equal(query["filters[product][id][$eq]"], 7);
      return {
        data: [{
          id: 70,
          attributes: {
            product: {
              data: {
                id: 7,
                attributes: {
                  Title: destinationTitle,
                  Slug: "bag-a001",
                  product_size_helper: {
                    data: { id: 8, attributes: { Helper: [["SIZE", "M"]] } },
                  },
                },
              },
            },
          },
        }],
      };
    },
    metrics() { return {}; },
  };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-reconcile-product-"));
  const ledger = new RunLedger(stateDir, "reconcile", "reconcile-product").start();
  try {
    await runReconcile({
      source,
      destination,
      ledger,
      pilot: {
        runId: "pilot",
        pilotSelection: { productIds: ["44"], userIds: [], walletIds: [], orders: [] },
      },
      dryRun: { runId: "dry-run", candidates: { blogPosts: [] } },
    });
    assert.equal(ledger.summary.entities.products.verified, expectedFailures === 0 ? 1 : 0);
    assert.equal(ledger.summary.failures.length, expectedFailures);
    return ledger.summary;
  } finally {
    ledger.release();
  }
}

test("product reconciliation includes inactive products and compares normalized titles", async () => {
  await runProductReconciliation({ destinationTitle: "کیف A 001" });
});

test("product reconciliation does not count a mismatched product as verified", async () => {
  const summary = await runProductReconciliation({ destinationTitle: "عنوان اشتباه", expectedFailures: 1 });
  assert.equal(summary.failures[0].code, "PRODUCT_TITLE_MISMATCH");
});

test("order reconciliation accepts Strapi null relation wrappers and verifies core fields", async () => {
  const sourceOrder = {
    id: 44,
    customer_id: 50,
    date_created_gmt: "2026-01-02T03:04:05",
    status: "processing",
    total: "1000",
    shipping_total: "50",
    payment_method: "zarinpal",
    line_items: [{
      id: 9,
      product_id: 3,
      variation_id: 4,
      quantity: 2,
      price: "475",
      name: "کالا",
      sku: "S",
    }],
  };
  const source = {
    async getOrder() { return sourceOrder; },
    metrics() { return {}; },
  };
  const destination = {
    async loadSnapshot() { return []; },
    async getContent(endpoint) {
      assert.equal(endpoint, "/orders");
      return {
        data: [{
          attributes: {
            Status: "Started",
            Date: "2026-01-02T03:04:05.000Z",
            ShippingCost: 500,
            PaymentGateway: "ZarinPal",
            delivery_address: { data: null },
            Description: null,
            Note: null,
            contract: { data: { attributes: { Status: "Confirmed", Amount: "10000" } } },
            user: { data: { attributes: { external_source: "wordpress", external_id: "50" } } },
            order_items: {
              data: [{
                attributes: {
                  external_id: "line_item_9",
                  Count: 2,
                  PerAmount: "4750",
                  product_variation: { data: { attributes: { external_id: "4" } } },
                },
              }],
            },
          },
        }],
      };
    },
    metrics() { return {}; },
  };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-reconcile-"));
  const ledger = new RunLedger(stateDir, "reconcile", "reconcile-order").start();
  try {
    await runReconcile({
      source,
      destination,
      ledger,
      pilot: {
        runId: "pilot",
        pilotSelection: {
          productIds: [],
          userIds: [],
          walletIds: [],
          orders: [{ sourceId: "44" }],
        },
      },
      dryRun: { runId: "dry-run", candidates: { blogPosts: [] } },
    });
    assert.equal(ledger.summary.entities.orders.verified, 1);
    assert.equal(ledger.summary.failures.length, 0);
  } finally {
    ledger.release();
  }
});
