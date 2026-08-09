"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getSyncConfig } = require("../config");
const { SyncStateStore } = require("../stateStore");
const {
  WooSyncService,
  JOBS,
  registerSchedulers,
  productRevision,
  orderRevision,
  catalogReportSummary,
  assertCatalogReportSucceeded,
} = require("../service");

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

test("sync config defaults to hourly-only and enforces documented concurrency caps", () => {
  const config = getSyncConfig(baseEnv());
  assert.equal(config.pollMs, 30_000);
  assert.deepEqual(config.schedules, {
    discovery: false,
    hourly: true,
    friday: false,
    reconcile: false,
  });
  assert.equal(config.reconcileCron, "30 2 * * *");
  assert.equal(config.sourcePageConcurrency, 4);
  assert.equal(config.identitySweepPages, 0);
  assert.deepEqual(config.concurrency, {
    products: 1,
    images: 4,
    variations: 8,
    videos: 1,
    entities: 8,
    fridayInventory: 32,
  });
  assert.throws(() => getSyncConfig({ ...baseEnv(), IMPORT_CONCURRENCY_IMAGES: "17" }), /between 1 and 16/);
  assert.throws(() => getSyncConfig({ ...baseEnv(), IMPORT_CONCURRENCY_VARIATIONS: "33" }), /between 1 and 32/);
  assert.throws(() => getSyncConfig({ ...baseEnv(), IMPORT_CONCURRENCY_VIDEOS: "3" }), /between 1 and 2/);
  assert.throws(() => getSyncConfig({ ...baseEnv(), WOOCOMMERCE_SYNC_SOURCE_PAGE_CONCURRENCY: "9" }), /between 1 and 8/);
  assert.throws(() => getSyncConfig({ ...baseEnv(), WOOCOMMERCE_SYNC_IDENTITY_SWEEP_PAGES: "26" }), /between 0 and 25/);
});

test("historical customer and wallet sweeps require explicit opt-in", async () => {
  const config = getSyncConfig(baseEnv());
  const service = Object.create(WooSyncService.prototype);
  service.config = config;
  Object.defineProperty(service, "state", {
    get() { throw new Error("identity sweep touched state while disabled"); },
  });
  await assert.doesNotReject(async () => {
    assert.deepEqual(await service.identitySweep("unused"), { customers: 0, wallets: 0 });
  });
  assert.equal(
    getSyncConfig({ ...baseEnv(), WOOCOMMERCE_SYNC_IDENTITY_SWEEP_PAGES: "5" }).identitySweepPages,
    5,
  );
});

test("identitySweep uses Woo orderby=id and TeraWallet orderby=registered", async () => {
  const config = getSyncConfig({ ...baseEnv(), WOOCOMMERCE_SYNC_IDENTITY_SWEEP_PAGES: "1" });
  const service = Object.create(WooSyncService.prototype);
  service.config = config;
  const walletQueries = [];
  const customerQueries = [];
  service.source = {
    woo: {
      async get(_pathname, query) {
        customerQueries.push(query);
        return { data: [{ id: 11 }], headers: { get: () => "1" } };
      },
    },
    wallet: {
      async get(_pathname, query) {
        walletQueries.push(query);
        return { data: [{ id: 22, balance: 0 }], headers: { get: () => "1" } };
      },
    },
  };
  service.state = {
    async control() { return { mode: "active" }; },
    async cursor() { return { sweep_page: 1 }; },
    async observe() {},
    async assertLease() {},
    async saveCursor() {},
  };
  const result = await service.identitySweep("token");
  assert.deepEqual(result, { customers: 1, wallets: 1 });
  assert.deepEqual(customerQueries[0], { per_page: 100, page: 1, orderby: "id", order: "asc" });
  assert.deepEqual(walletQueries[0], { per_page: 100, page: 1, orderby: "registered", order: "asc" });
  assert.notEqual(walletQueries[0].orderby, "id");
});

test("scheduler defaults to hourly only and removes discovery, Friday, and reconcile schedules", async () => {
  const calls = [];
  const removed = [];
  const queue = {
    async upsertJobScheduler(...args) { calls.push(args); },
    async removeJobScheduler(id) { removed.push(id); },
  };
  const config = getSyncConfig(baseEnv());
  await registerSchedulers(queue, config);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { pattern: "0 * * * *", tz: "Asia/Tehran" });
  assert.equal(calls[0][2].name, JOBS.hourly);
  assert.deepEqual(removed, [
    "sched:woocommerce.discovery",
    "sched:woocommerce.friday-cutover",
    "sched:woocommerce.reconcile",
  ]);
});

test("30-second discovery, Friday, and reconcile schedules require explicit opt-in", async () => {
  const calls = [];
  const queue = {
    async upsertJobScheduler(...args) { calls.push(args); },
    async removeJobScheduler() {},
  };
  const config = getSyncConfig({
    ...baseEnv(),
    WOOCOMMERCE_SYNC_ENABLE_DISCOVERY: "true",
    WOOCOMMERCE_SYNC_ENABLE_FRIDAY: "true",
    WOOCOMMERCE_SYNC_ENABLE_RECONCILE: "true",
  });
  await registerSchedulers(queue, config);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0][1], { every: 30_000 });
  assert.deepEqual(calls[1][1], { pattern: "0 * * * *", tz: "Asia/Tehran" });
  assert.deepEqual(calls[2][1], { pattern: "59 23 * * 5", tz: "Asia/Tehran" });
  assert.equal(calls[2][2].opts.attempts, 3);
  assert.deepEqual(calls[3][1], { pattern: "30 2 * * *", tz: "Asia/Tehran" });
  assert.equal(calls[3][2].name, JOBS.reconcile);
});

test("reconcile cadence is configurable via WOOCOMMERCE_SYNC_RECONCILE_CRON", async () => {
  const calls = [];
  const queue = {
    async upsertJobScheduler(...args) { calls.push(args); },
    async removeJobScheduler() {},
  };
  const config = getSyncConfig({
    ...baseEnv(),
    WOOCOMMERCE_SYNC_ENABLE_RECONCILE: "true",
    WOOCOMMERCE_SYNC_RECONCILE_CRON: "0 4 * * 0",
  });
  assert.equal(config.reconcileCron, "0 4 * * 0");
  await registerSchedulers(queue, config);
  const reconcileCall = calls.find((call) => call[2].name === JOBS.reconcile);
  assert.deepEqual(reconcileCall[1], { pattern: "0 4 * * 0", tz: "Asia/Tehran" });
});

test("Friday catalog stages fail closed before dependent identity and order work", () => {
  const clean = catalogReportSummary("stock", {
    toJSON: () => ({ totals: { completed: 10 }, failures: [] }),
  });
  assert.doesNotThrow(() => assertCatalogReportSucceeded(clean));

  const failed = catalogReportSummary("price", {
    toJSON: () => ({ totals: { completed: 9, failed: 1 }, failures: [{ wcId: 44 }] }),
  });
  assert.throws(
    () => assertCatalogReportSucceeded(failed),
    (error) => error.code === "FRIDAY_PRICE_HAS_FAILURES",
  );
});

test("source revisions change only when watched order/product fields change", () => {
  const product = { id: 1, date_modified_gmt: "2026-08-05T00:00:00", price: "10", stock_quantity: 2, variations: [3] };
  assert.equal(productRevision(product), productRevision({ ...product }));
  assert.notEqual(productRevision(product), productRevision({ ...product, stock_quantity: 3 }));
  const order = {
    id: 5,
    date_modified_gmt: "2026-08-05T00:00:00",
    status: "processing",
    line_items: [{ id: 7, product_id: 1, variation_id: 3, quantity: 1, total: "10" }],
  };
  assert.equal(orderRevision(order), orderRevision({ ...order }));
  assert.notEqual(orderRevision(order), orderRevision({ ...order, status: "completed" }));
});

test("shadow mode blocks destination work before any source fetch or write", async () => {
  const config = getSyncConfig(baseEnv());
  const source = { getOrder: async () => { throw new Error("source must not be read"); } };
  const destination = { upsertOrder: async () => { throw new Error("destination must not be written"); } };
  const pool = { end: async () => undefined };
  const service = new WooSyncService(config, { pool, source, destination });
  service.state = { control: async () => ({ mode: "shadow" }) };
  await assert.rejects(
    service.syncOrderRow({ source_id: 1 }, new Set()),
    /gated until historical reconciliation/,
  );
});

test("active control update casts repeated PostgreSQL parameters explicitly", async () => {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [{ mode: "active" }] };
    },
  };
  const state = new SyncStateStore(pool, { owner: "test-owner" });
  const hash = "a".repeat(64);

  const control = await state.setMode("active", {
    reconciliationRunId: "reconciliation-1",
    reconciliationSha256: hash,
  });

  assert.equal(control.mode, "active");
  assert.match(queries[0].sql, /mode = \$1::varchar/);
  assert.match(queries[0].sql, /WHEN \$1::varchar = 'active'/);
  assert.deepEqual(queries[0].params, ["active", "reconciliation-1", hash]);
});

test("an active variation-sweep first sighting is queued in hourly rather than immediate", async () => {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [{ id: 1, source_type: "product-sweep", source_id: "44", lane: "hourly", status: "observed" }] };
    },
  };
  const state = new SyncStateStore(pool, { owner: "test-owner" });

  await state.observe({
    sourceType: "product-sweep",
    sourceId: 44,
    revisionSha256: "b".repeat(64),
  }, "active", { insertLane: "hourly" });

  assert.equal(queries[0].params[5], "hourly");
  assert.equal(queries[0].params[6], "pending");
  assert.equal(queries[0].params[7], true);
});

test("hourly polls changes and drains active immediate and no-media lanes in order", async () => {
  const config = getSyncConfig(baseEnv());
  const pool = { end: async () => undefined };
  const source = { metrics: () => ({ requests: 2 }) };
  const destination = { metrics: () => ({ requests: 0 }) };
  const service = new WooSyncService(config, { pool, source, destination });
  const calls = [];
  const metrics = [];
  service.state = {
    control: async () => ({ mode: "active" }),
    metric: async (value) => metrics.push(value),
  };
  service.withLease = async (name, action) => {
    calls.push(["lease", name]);
    return action("hourly-fence");
  };
  service.pollChanges = async (leaseName, token) => {
    calls.push(["poll", leaseName, token]);
    return { products: { observed: 2 }, orders: { observed: 1 } };
  };
  service.variationSweep = async (token) => {
    calls.push(["sweep", token]);
    return 10;
  };
  service.identitySweep = async (token) => {
    calls.push(["identity-sweep", token]);
    return { customers: 5, wallets: 5 };
  };
  service.drain = async (lane, token) => {
    calls.push(["drain", lane, token]);
    return lane === "immediate" ? { completed: 1, failed: 0 } : { completed: 2, failed: 1 };
  };

  const result = await service.hourly();

  assert.deepEqual(calls, [
    ["lease", "drain:hourly"],
    ["poll", "drain:hourly", "hourly-fence"],
    ["sweep", "hourly-fence"],
    ["identity-sweep", "hourly-fence"],
    ["drain", "immediate", undefined],
    ["drain", "hourly", "hourly-fence"],
  ]);
  assert.deepEqual({ completed: result.completed, failed: result.failed }, { completed: 3, failed: 1 });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].stage, "hourly");
  assert.equal(metrics[0].itemCount, 4);
});

test("hourly product drain uses full-sync preserve media scope", async () => {
  const config = getSyncConfig(baseEnv());
  const pool = { end: async () => undefined };
  const service = new WooSyncService(config, { pool, source: {}, destination: {} });
  const processed = [];
  let claims = 0;
  service.state = {
    control: async () => ({ mode: "active", reconciliation_run_id: "accepted", reconciliation_sha256: "a".repeat(64) }),
    assertLease: async () => undefined,
    claimItems: async () => {
      claims += 1;
      return claims === 1 ? [{ id: 1, source_type: "product", source_id: 44 }] : [];
    },
    completeItem: async () => undefined,
  };
  service.processProductRows = async (rows, scope) => {
    processed.push({ rows, scope });
    return new Map();
  };

  const result = await service.drain("hourly", "hourly-fence");

  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(processed.length, 1);
  assert.equal(processed[0].scope, "full-sync");
});

test("Woo delta polling reads all pages with a bounded worker pool and checkpoints once", async () => {
  const config = { ...getSyncConfig(baseEnv()), sourcePageConcurrency: 2 };
  const requestedPages = [];
  const rows = {
    1: [{ id: 1, date_modified_gmt: "2026-08-05T00:00:01" }],
    2: [{ id: 2, date_modified_gmt: "2026-08-05T00:00:02" }],
    3: [{ id: 3, date_modified_gmt: "2026-08-05T00:00:03" }],
  };
  const source = {
    woo: {
      get: async (_pathname, params) => {
        requestedPages.push(params.page);
        return {
          data: rows[params.page],
          headers: { get: (name) => name === "x-wp-totalpages" ? "3" : null },
        };
      },
    },
  };
  const service = new WooSyncService(config, { pool: { end: async () => undefined }, source, destination: {} });
  const observed = [];
  const checkpoints = [];
  service.state = {
    cursor: async () => ({ cursor_time: null, cursor_id: "0", sweep_page: 1 }),
    control: async () => ({ mode: "shadow" }),
    observe: async (row, mode) => observed.push({ row, mode }),
    assertLease: async () => undefined,
    saveCursor: async (...args) => checkpoints.push(args),
  };

  const result = await service.pollWooEntity({
    sourceType: "order",
    pathname: "/orders",
    params: (modifiedAfter) => ({ modified_after: modifiedAfter, orderby: "modified" }),
    revision: orderRevision,
  }, "drain:hourly", "hourly-fence");

  assert.equal(result.observed, 3);
  assert.deepEqual(requestedPages.sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(observed.length, 3);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0][0], "order");
  assert.equal(checkpoints[0][1].cursorId, 3);
  assert.equal(checkpoints[0][2], "drain:hourly");
  assert.equal(checkpoints[0][3], "hourly-fence");
});

test("shadow order bootstrap records only the newest high-water row", async () => {
  const config = getSyncConfig(baseEnv());
  const requests = [];
  const source = {
    woo: {
      get: async (_pathname, params) => {
        requests.push(params);
        return {
          data: [{ id: 99, date_modified_gmt: "2026-08-05T10:00:00" }],
          headers: { get: () => "531" },
        };
      },
    },
  };
  const service = new WooSyncService(config, { pool: { end: async () => undefined }, source, destination: {} });
  const observed = [];
  const checkpoints = [];
  service.state = {
    cursor: async () => ({ cursor_time: null, cursor_id: "0", sweep_page: 1 }),
    control: async () => ({ mode: "shadow" }),
    observe: async (row, mode) => observed.push({ row, mode }),
    assertLease: async () => undefined,
    saveCursor: async (...args) => checkpoints.push(args),
  };

  const result = await service.pollWooEntity({
    sourceType: "order",
    pathname: "/orders",
    params: (modifiedAfter) => ({ modified_after: modifiedAfter, orderby: "modified", order: "asc" }),
    revision: orderRevision,
    bootstrapLatest: true,
  }, "drain:hourly", "hourly-fence");

  assert.deepEqual(result, { observed: 1, bootstrapped: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].per_page, 1);
  assert.equal(requests[0].order, "desc");
  assert.equal(observed.length, 1);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0][1].cursorId, 99);
  assert.equal(checkpoints[0][1].cursorTime, "2026-08-05T10:00:00.000Z");
});

test("variation sweep routes active first sightings to the no-media hourly lane", async () => {
  const config = getSyncConfig(baseEnv());
  const observations = [];
  const source = {
    woo: {
      get: async () => ({
        data: [{ id: 44, type: "simple", variations: [], date_modified_gmt: "2026-08-05T10:00:00" }],
        headers: { get: () => "1" },
      }),
    },
  };
  const service = new WooSyncService(config, { pool: { end: async () => undefined }, source, destination: {} });
  service.state = {
    cursor: async () => ({ cursor_time: null, cursor_id: "0", sweep_page: 1 }),
    control: async () => ({ mode: "active" }),
    observe: async (...args) => observations.push(args),
    saveCursor: async () => undefined,
  };

  const swept = await service.variationSweep("hourly-fence");

  assert.equal(swept, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0][0].sourceType, "product-sweep");
  assert.equal(observations[0][1], "active");
  assert.deepEqual(observations[0][2], { insertLane: "hourly" });
});

test("reconcile refuses to touch CatalogEngine or the source when sync is not active", async () => {
  const config = getSyncConfig(baseEnv());
  const service = new WooSyncService(config, { pool: { end: async () => undefined }, source: {}, destination: {} });
  service.withLease = async (name, action) => action("reconcile-fence");
  service.state = {
    control: async () => ({ mode: "shadow" }),
    metric: async () => undefined,
  };
  service.runCatalogVerify = async () => { throw new Error("must not reach CatalogEngine while inactive"); };

  await assert.rejects(service.reconcile(), /gated until historical reconciliation/);
});

test("reconcile observes missed WooCommerce products into the hourly lane and drains them in the same run", async () => {
  const config = getSyncConfig(baseEnv());
  const service = new WooSyncService(config, { pool: { end: async () => undefined }, source: {}, destination: {} });
  const observed = [];
  const drainCalls = [];
  const metrics = [];
  service.withLease = async (name, action) => action("reconcile-fence");
  service.state = {
    control: async () => ({ mode: "active", reconciliation_run_id: "r1", reconciliation_sha256: "a".repeat(64) }),
    observe: async (...args) => observed.push(args),
    metric: async (m) => metrics.push(m),
  };
  service.source = { getProduct: async (id) => ({ id, date_modified_gmt: "2026-08-08T00:00:00" }) };
  service.runCatalogVerify = async () => ({ engine: {}, wcOnly: [101, 102], strapiOnly: [] });
  service.repairMissingProductMedia = async () => ({ repaired: 0 });
  service.drain = async (lane) => {
    drainCalls.push(lane);
    return { completed: 2, failed: 0 };
  };

  const result = await service.reconcile();

  assert.deepEqual(result.missed, { found: 2, observed: 2, failed: 0 });
  assert.deepEqual(drainCalls, ["hourly"]);
  assert.equal(observed.length, 2);
  assert.equal(observed[0][0].sourceType, "product");
  assert.equal(observed[0][1], "active");
  assert.deepEqual(observed[0][2], { insertLane: "hourly" });
  assert.deepEqual(result.media, { repaired: 0 });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].stage, "reconcile");
  assert.equal(metrics[0].outcome, "completed");
});

test("reconcile classifies target orphans by re-fetch outcome and never mutates any of them", async () => {
  const config = getSyncConfig(baseEnv());
  const service = new WooSyncService(config, { pool: { end: async () => undefined }, source: {}, destination: {} });
  const metrics = [];
  service.withLease = async (name, action) => action("reconcile-fence");
  service.state = {
    control: async () => ({ mode: "active", reconciliation_run_id: "r1", reconciliation_sha256: "a".repeat(64) }),
    observe: async () => { throw new Error("must not observe for strapiOnly ids"); },
    metric: async (m) => metrics.push(m),
  };
  service.source = {
    getProduct: async (id) => {
      // 201: genuinely gone (clean 404). 202: source unreachable (5xx) — must
      // NOT be inferred as deletion. 203: the compare just missed it — found.
      if (id === 201) {
        const error = new Error("HTTP_404");
        error.status = 404;
        throw error;
      }
      if (id === 202) {
        const error = new Error("HTTP_503");
        error.status = 503;
        throw error;
      }
      return { id, date_modified_gmt: "2026-08-08T00:00:00" };
    },
  };
  service.runCatalogVerify = async () => ({ engine: {}, wcOnly: [], strapiOnly: [201, 202, 203] });
  service.repairMissingProductMedia = async () => ({ repaired: 0 });
  service.drain = async () => { throw new Error("must not drain when nothing was observed"); };

  const result = await service.reconcile();

  assert.equal(result.orphans.candidates, 3);
  assert.deepEqual(result.orphans.byStatus, {
    source_confirmed_missing: 1,
    source_unknown: 1,
  });
  assert.deepEqual(result.drained, { completed: 0, failed: 0 });
});
