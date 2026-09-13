"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RunLedger } = require("../lib/ledger");
const { runReconcile, buildFullReconciliationInputs } = require("../reconcile");

test("full reconciliation enumerates every source entity read-only and uses completed catalog products", async () => {
  const pages = (rows) => async function* () { yield { page: 1, rows }; };
  const source = {
    customers: pages([{ id: 10 }, { id: 11 }]),
    walletUsers: pages([{ id: 10 }]),
    posts: pages([{ id: 20 }, { id: 21 }]),
    orders: pages([{ id: 30 }, { id: 31 }]),
  };
  const fullRun = { runId: "full-1", command: "full", status: "completed" };
  const catalogRun = {
    acceptedExceptions: {
      manifestSha256: "a".repeat(64),
      dependentOrderIds: ["31"],
      entries: [{ key: "product:2" }],
    },
    items: {
      "product:1": { entity: "products", wcId: 1, status: "completed" },
      "product:2": { entity: "products", wcId: 2, status: "failed" },
    },
  };
  const inputs = await buildFullReconciliationInputs(source, fullRun, catalogRun);
  assert.deepEqual(inputs.pilot.pilotSelection.productIds, ["1"]);
  assert.deepEqual(inputs.pilot.pilotSelection.userIds, ["10", "11"]);
  assert.deepEqual(inputs.pilot.pilotSelection.walletIds, ["10"]);
  assert.deepEqual(inputs.pilot.pilotSelection.orders, [{ sourceId: "30" }]);
  assert.equal(inputs.pilot.acceptedExceptions.manifestSha256, "a".repeat(64));
  assert.deepEqual(inputs.dryRun.candidates.blogPosts, ["20", "21"]);
});

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
      if (entity === "variations") {
        return [{ id: 70, external_source: "woocommerce", external_id: "44" }];
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
            createdAt: "2026-01-02T03:04:05.000Z",
            updatedAt: "2026-01-02T03:04:05.000Z",
            Status: "Started",
            Date: "2026-01-02T03:04:05.000Z",
            ShippingCost: 50,
            PaymentGateway: "ZarinPal",
            delivery_address: { data: null },
            Description: null,
            Note: null,
            contract: { data: { attributes: {
              Status: "Confirmed",
              Type: "Cash",
              TaxPercent: 0,
              Amount: "1000",
              createdAt: "2026-01-02T03:04:05.000Z",
              updatedAt: "2026-01-02T03:04:05.000Z",
            } } },
            user: { data: { attributes: { external_source: "wordpress", external_id: "50" } } },
            order_items: {
              data: [{
                attributes: {
                  createdAt: "2026-01-02T03:04:05.000Z",
                  updatedAt: "2026-01-02T03:04:05.000Z",
                  external_id: "line_item_9",
                  Count: 2,
                  PerAmount: "475",
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

test("order reconciliation accepts an orphan line with no catalog relation and checks its snapshot", async () => {
  const sourceOrder = {
    id: 45,
    customer_id: 50,
    date_created_gmt: "2026-01-02T03:04:05",
    status: "processing",
    total: "1000",
    shipping_total: "0",
    payment_method: "zarinpal",
    line_items: [{ id: 9, product_id: 0, variation_id: 0, quantity: 2, total: "1000", name: "کالای حذف‌شده" }],
  };
  const source = {
    async getOrder() { return sourceOrder; },
    metrics() { return {}; },
  };
  const orderItem = (overrides) => ({
    attributes: {
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
      external_id: "line_item_9",
      Count: 2,
      PerAmount: "500",
      ProductTitle: "کالای حذف‌شده",
      ProductSKU: "WC-LINE-9",
      product_variation: { data: null },
      ...overrides,
    },
  });
  const destinationWith = (item) => ({
    async loadSnapshot() { return []; },
    async getContent() {
      return {
        data: [{
          attributes: {
            createdAt: "2026-01-02T03:04:05.000Z",
            updatedAt: "2026-01-02T03:04:05.000Z",
            Status: "Started",
            Date: "2026-01-02T03:04:05.000Z",
            ShippingCost: 0,
            PaymentGateway: "ZarinPal",
            delivery_address: { data: null },
            Description: null,
            Note: null,
            contract: { data: { attributes: {
              Status: "Confirmed",
              Type: "Cash",
              TaxPercent: 0,
              Amount: "1000",
              createdAt: "2026-01-02T03:04:05.000Z",
              updatedAt: "2026-01-02T03:04:05.000Z",
            } } },
            user: { data: { attributes: { external_source: "wordpress", external_id: "50" } } },
            order_items: { data: [item] },
          },
        }],
      };
    },
    metrics() { return {}; },
  });
  const run = async (item) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-reconcile-orphan-"));
    const ledger = new RunLedger(stateDir, "reconcile", "reconcile-orphan").start();
    try {
      await runReconcile({
        source,
        destination: destinationWith(item),
        ledger,
        pilot: {
          runId: "pilot",
          pilotSelection: { productIds: [], userIds: [], walletIds: [], orders: [{ sourceId: "45" }] },
        },
        dryRun: { runId: "dry-run", candidates: { blogPosts: [] } },
      });
      return ledger.summary;
    } finally {
      ledger.release();
    }
  };

  const clean = await run(orderItem());
  assert.equal(clean.entities.orders.verified, 1);
  assert.equal(clean.failures.length, 0);

  // A relation invented for a line the source has no reference for is a defect,
  // not a repair — reconciliation must say so.
  const invented = await run(orderItem({ product_variation: { data: { attributes: { external_id: "4" } } } }));
  assert.ok(
    invented.failures.some((failure) => failure.code === "ORDER_ITEM_ORPHAN_HAS_CATALOG_RELATION"),
    JSON.stringify(invented.failures),
  );

  // The snapshot is all that is left of the sale, so a wrong SKU is a mismatch.
  const wrongSku = await run(orderItem({ ProductSKU: "WC-4" }));
  assert.ok(
    wrongSku.failures.some((failure) => failure.code === "ORDER_ITEM_SKU_MISMATCH"),
    JSON.stringify(wrongSku.failures),
  );
});
