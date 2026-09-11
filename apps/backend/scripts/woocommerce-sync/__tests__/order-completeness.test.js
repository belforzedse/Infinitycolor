"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compareOrderIds, parseArgs } = require("../reconcile-orders");
const { ensureOrderReferencedVariations, lineRefs } = require("../ensureOrderVariations");
const { WooSyncService } = require("../service");
const { getSyncConfig } = require("../config");
const { SyncStateStore } = require("../stateStore");

function baseEnv() {
  return {
    DATABASE_PASSWORD: "db-secret",
    WP_USERNAME: "reader",
    WP_APPLICATION_PASSWORD: "wp-secret",
    WOOCOMMERCE_CONSUMER_KEY: "ck_reader",
    WOOCOMMERCE_CONSUMER_SECRET: "cs_reader",
    STRAPI_API_TOKEN_PRODUCTION: "destination-token",
    MIGRATION_CONTROL_TOKEN: "m".repeat(32),
  };
}

test("compareOrderIds reports missing, duplicates, and status mismatches", () => {
  const destination = new Map([
    ["10", { status: "Done", count: 1 }],
    ["11", { status: "Cancelled", count: 2 }],
    ["12", { status: "Done", count: 1 }],
  ]);
  const sourceStatus = new Map([
    ["10", "Done"],
    ["11", "Done"],
    ["13", "Done"],
  ]);
  const report = compareOrderIds(["10", "11", "13", "10"], destination, sourceStatus);
  assert.equal(report.expectedSourceCount, 3);
  assert.equal(report.importedCount, 2);
  assert.deepEqual(report.missing, ["13"]);
  assert.deepEqual(report.duplicates, ["11"]);
  assert.equal(report.statusMismatches.length, 1);
  assert.equal(report.statusMismatches[0].sourceId, "11");
});

test("compareOrderIds page-boundary fixtures: N-1, N, N+1", () => {
  const pageSize = 3;
  for (const sourceSize of [pageSize - 1, pageSize, pageSize + 1]) {
    const sourceIds = Array.from({ length: sourceSize }, (_, i) => String(100 + i));
    const destination = new Map(sourceIds.slice(0, sourceSize - 1).map((id) => [id, { status: "Done", count: 1 }]));
    const report = compareOrderIds(sourceIds, destination);
    assert.equal(report.expectedSourceCount, sourceSize);
    assert.equal(report.missingCount, 1);
    assert.deepEqual(report.missing, [String(100 + sourceSize - 1)]);
  }
});

test("parseArgs requires exactly one of dry-run or apply", () => {
  assert.throws(() => parseArgs([]), /exactly one/);
  assert.throws(() => parseArgs(["--dry-run", "--apply"]), /exactly one/);
  assert.deepEqual(parseArgs(["--dry-run", "--limit", "5"]).limit, 5);
});

test("lineRefs maps variation_id=0 to product_id", () => {
  assert.deepEqual(lineRefs({
    line_items: [
      { id: 1, product_id: 9, variation_id: 0 },
      { id: 2, product_id: 9, variation_id: 44 },
    ],
  }), [
    { productSourceId: "9", variationSourceId: "9", lineId: "1" },
    { productSourceId: "9", variationSourceId: "44", lineId: "2" },
  ]);
});

test("ensureOrderReferencedVariations creates missing variation with stock 0", async () => {
  const created = [];
  const repo = {
    async findByExternalId(endpoint, id) {
      if (endpoint === "/product-variations") return null;
      if (endpoint === "/products" && String(id) === "9") return { id: 900 };
      return null;
    },
    async upsert({ endpoint, externalId, payload }) {
      created.push({ endpoint, externalId, payload });
      return { id: 501, mode: "created" };
    },
    async upsertStock(args) {
      created.push({ stock: args });
      return "created";
    },
  };
  const source = {
    async getProduct(id) {
      return {
        id: Number(id),
        name: "parent",
        sku: "P",
        regular_price: "1000",
        price: "1000",
        manage_stock: false,
        variations: [44],
      };
    },
    woo: {
      async get(pathname) {
        assert.match(pathname, /\/products\/9\/variations\/44$/);
        return {
          data: {
            id: 44,
            parent_id: 9,
            regular_price: "1000",
            price: "1000",
            manage_stock: false,
            stock_quantity: null,
            status: "publish",
            attributes: [],
          },
        };
      },
    },
  };

  const result = await ensureOrderReferencedVariations({
    source,
    repo,
    order: {
      line_items: [{ id: 1, product_id: 9, variation_id: 44, quantity: 1, total: "1000", price: "1000" }],
    },
    logger: { info() {}, warn() {} },
  });

  assert.deepEqual(result.ensured, ["44"]);
  assert.equal(result.failed.length, 0);
  assert.equal(created.some((row) => row.endpoint === "/product-variations"), true);
  assert.equal(created.some((row) => row.stock && row.stock.count === 0), true);
});

test("syncOrderRow isolates wallet failure and still upserts the order", async () => {
  const config = getSyncConfig(baseEnv());
  const upserted = [];
  const service = new WooSyncService(config, {
    pool: { end: async () => undefined, query: async () => ({ rows: [], rowCount: 0 }) },
    source: {
      async getOrder() {
        return {
          id: 55,
          customer_id: 7,
          date_created_gmt: "2026-01-02T03:04:05",
          date_modified_gmt: "2026-01-02T03:04:05",
          status: "completed",
          total: "1000",
          shipping_total: "0",
          total_tax: "0",
          payment_method: "wallet",
          billing: { phone: "09121234567", first_name: "A", last_name: "B" },
          line_items: [{
            id: 1, product_id: 3, variation_id: 4, quantity: 1, price: "1000", total: "1000", name: "x",
          }],
        };
      },
      async getCustomer() {
        return { id: 7, billing: { phone: "09121234567" }, email: "a@b.c" };
      },
      async getWalletBalance() {
        return { balance_base: 690818999.9999999 };
      },
    },
    destination: {
      async upsertUser() { return { mode: "updated" }; },
      async upsertWallet(payload) {
        upserted.push(["wallet", payload.balanceRial]);
        return { mode: "updated" };
      },
      async upsertOrder(payload) {
        upserted.push(["order", payload.sourceId]);
        return { mode: "created", itemsUnresolved: 0, identityIssues: [], itemIssues: [] };
      },
    },
  });
  service.state = { control: async () => ({ mode: "active", reconciliation_run_id: "r", reconciliation_sha256: "a".repeat(64) }) };
  service.ensureOrderVariations = async () => ({ ensured: [], present: ["4"], failed: [] });

  const result = await service.syncOrderRow({ source_id: 55 });
  assert.equal(result.mode, "created");
  assert.deepEqual(upserted, [
    ["wallet", "6908190000"],
    ["order", "55"],
  ]);
});

test("syncOrderRow continues when customer upsert throws", async () => {
  const config = getSyncConfig(baseEnv());
  let orderUpserted = false;
  const service = new WooSyncService(config, {
    pool: { end: async () => undefined },
    source: {
      async getOrder() {
        return {
          id: 56,
          customer_id: 8,
          date_created_gmt: "2026-01-02T03:04:05",
          date_modified_gmt: "2026-01-02T03:04:05",
          status: "completed",
          total: "1000",
          shipping_total: "0",
          total_tax: "0",
          payment_method: "cod",
          billing: { phone: "09121234567" },
          line_items: [{
            id: 1, product_id: 3, variation_id: 4, quantity: 1, price: "1000", total: "1000", name: "x",
          }],
        };
      },
      async getCustomer() { return { id: 8, billing: { phone: "09121234567" } }; },
      async getWalletBalance() {
        const error = new Error("HTTP_404");
        error.status = 404;
        error.payload = { error: "NOT_FOUND" };
        throw error;
      },
    },
    destination: {
      async upsertUser() {
        const error = new Error("USER_PHONE_SOURCE_CONFLICT");
        error.payload = { error: "USER_PHONE_SOURCE_CONFLICT" };
        throw error;
      },
      async upsertWallet() { return { mode: "updated" }; },
      async upsertOrder() {
        orderUpserted = true;
        return { mode: "created", itemsUnresolved: 0, identityIssues: [], itemIssues: [] };
      },
    },
  });
  service.state = { control: async () => ({ mode: "active", reconciliation_run_id: "r", reconciliation_sha256: "a".repeat(64) }) };
  service.ensureOrderVariations = async () => ({ ensured: [], present: ["4"], failed: [] });

  const result = await service.syncOrderRow({ source_id: 56 });
  assert.equal(orderUpserted, true);
  assert.equal(result.hasSoftIssues, true);
  assert.ok(result.sideIssues.some((code) => /USER_PHONE_SOURCE_CONFLICT/.test(code)));
});

test("fullOrders records durable outcomes for success and failure", async () => {
  const config = getSyncConfig(baseEnv());
  const outcomes = [];
  const service = new WooSyncService(config, {
    pool: { end: async () => undefined },
    source: {
      async *orders() {
        yield {
          page: 1,
          rows: [
            { id: 1, date_modified_gmt: "2026-01-01T00:00:00", status: "completed", total: "1" },
            { id: 2, date_modified_gmt: "2026-01-01T00:00:00", status: "completed", total: "1" },
          ],
        };
      },
    },
    destination: {},
  });
  service.syncOrderRow = async (row) => {
    if (String(row.source_id) === "2") throw Object.assign(new Error("ORDER_ITEMS_EMPTY"), { code: "ORDER_ITEMS_EMPTY" });
    return { mode: "created", hasSoftIssues: false };
  };
  service.state = {
    async recordOrderOutcome(args) {
      outcomes.push(args);
      return { id: 1, status: args.outcome };
    },
  };

  const result = await service.fullOrders({ concurrency: 2 });
  assert.deepEqual(result, { completed: 1, failed: 1, softIssues: 0, fetched: 2 });
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes.find((row) => String(row.sourceId) === "1").outcome, "completed");
  assert.equal(outcomes.find((row) => String(row.sourceId) === "2").outcome, "failed");
  assert.equal(outcomes.find((row) => String(row.sourceId) === "2").errorCode, "ORDER_ITEMS_EMPTY");
});

test("requeueOrders SQL marks quarantined rows pending", async () => {
  const calls = [];
  const store = new SyncStateStore({
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 1, source_id: 99, last_error_code: "ORDER_ITEM_VARIATION_NOT_UNIQUE" }], rowCount: 1 };
    },
  }, { owner: "test" });

  const rows = await store.requeueOrders({ statuses: ["quarantined"], limit: 10 });
  assert.equal(rows.length, 1);
  assert.match(calls[0].sql, /status = 'pending'/);
  assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(calls[0].params[0], ["quarantined"]);
});

const campaignOrder = {
  id: 55,
  customer_id: 7,
  date_created_gmt: "2026-01-02T03:04:05",
  date_modified_gmt: "2026-01-02T03:04:05",
  status: "completed",
  total: "1000",
  shipping_total: "0",
  total_tax: "0",
  payment_method: "wallet",
  billing: { phone: "09121234567", first_name: "A", last_name: "B" },
  line_items: [{ id: 1, product_id: 3, variation_id: 4, quantity: 1, price: "1000", total: "1000", name: "x" }],
};

function campaignOrderService(calls) {
  const config = getSyncConfig(baseEnv());
  const service = new WooSyncService(config, {
    pool: { end: async () => undefined },
    source: {
      async getOrder() {
        calls.getOrder += 1;
        throw new Error("the campaign already holds this order; it must not be refetched");
      },
      async getCustomer() {
        calls.getCustomer += 1;
        return { id: 7, billing: { phone: "09121234567" }, email: "a@b.c" };
      },
      async getWalletBalance() {
        calls.getWalletBalance += 1;
        throw new Error("balance must come from the bulk snapshot");
      },
    },
    destination: {
      async upsertUser() { calls.upsertUser += 1; return { mode: "updated" }; },
      async upsertWallet(payload) { calls.upsertWallet.push(payload.balanceRial); return { mode: "updated" }; },
      async upsertOrder() {
        calls.upsertOrder += 1;
        return { mode: "created", itemsUnresolved: 0, identityIssues: [], itemIssues: [] };
      },
    },
  });
  service.state = { control: async () => ({ mode: "active", reconciliation_run_id: "r", reconciliation_sha256: "a".repeat(64) }) };
  service.ensureOrderVariations = async () => ({ ensured: [], present: ["4"], failed: [] });
  return service;
}

const emptyCalls = () => ({ getOrder: 0, getCustomer: 0, getWalletBalance: 0, upsertUser: 0, upsertWallet: [], upsertOrder: 0 });

test("a prefetched order is used as-is instead of being refetched from Woo", async () => {
  const calls = emptyCalls();
  const service = campaignOrderService(calls);
  const result = await service.syncOrderRow({ source_id: 55 }, { order: campaignOrder });
  assert.equal(result.mode, "created");
  assert.equal(calls.getOrder, 0);
  assert.equal(calls.upsertOrder, 1);
});

test("a customer this campaign already provisioned is not re-provisioned by their orders", async () => {
  const calls = emptyCalls();
  const service = campaignOrderService(calls);
  await service.syncOrderRow({ source_id: 55 }, {
    order: campaignOrder,
    mappedCustomers: new Set(["7"]),
  });
  assert.equal(calls.getCustomer, 0);
  assert.equal(calls.upsertUser, 0);
  assert.deepEqual(calls.upsertWallet, [], "the identity stage already wrote this wallet from the same snapshot");
  assert.equal(calls.upsertOrder, 1, "the order itself is still written");
});

test("an unmapped customer is still fully provisioned, with the balance taken from the snapshot", async () => {
  const calls = emptyCalls();
  const service = campaignOrderService(calls);
  await service.syncOrderRow({ source_id: 55 }, {
    order: campaignOrder,
    mappedCustomers: new Set(),
    // TeraWallet stores toman; the destination takes rial.
    walletBalances: new Map([["7", 1234]]),
  });
  assert.equal(calls.getCustomer, 1);
  assert.equal(calls.upsertUser, 1);
  assert.deepEqual(calls.upsertWallet, ["12340"]);
  assert.equal(calls.getWalletBalance, 0, "the snapshot must be preferred over a per-id read");
});

test("ensureOrderReferencedVariations prefers a prebuilt index and writes new rows back into it", async () => {
  const lookups = [];
  const repo = {
    async findByExternalId(endpoint, externalId) {
      lookups.push({ endpoint, externalId });
      return endpoint === "/products" ? { id: 900 } : null;
    },
    async upsert({ externalId, index }) {
      index.set(String(externalId), { id: 4242 });
      return { id: 4242, mode: "created" };
    },
    async upsertStock() { return "created"; },
  };
  const source = {
    async getProduct() {
      return { id: 3, type: "variable", variations: [4], sku: "S", price: "10", regular_price: "10" };
    },
    woo: {
      async get() {
        return { data: { id: 4, manage_stock: true, stock_quantity: 2, regular_price: "10", price: "10", attributes: [] } };
      },
    },
  };

  const variationIndex = new Map([["4", { id: 10004 }]]);
  const hit = await ensureOrderReferencedVariations({
    source, repo, order: campaignOrder, logger: { info() {}, warn() {} }, variationIndex,
  });
  assert.deepEqual(hit.present, ["4"]);
  assert.equal(lookups.length, 0, "an index hit must not cost a Strapi lookup");

  const missIndex = new Map();
  const miss = await ensureOrderReferencedVariations({
    source, repo, order: campaignOrder, logger: { info() {}, warn() {} }, variationIndex: missIndex,
  });
  assert.deepEqual(miss.ensured, ["4"]);
  assert.equal(missIndex.get("4").id, 4242, "a created variation must be written back into the snapshot");
});
