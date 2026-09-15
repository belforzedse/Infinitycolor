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
  safeErrorCode,
  fridayScheduledTimestamp,
  describeError,
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
    fridayImages: 12,
    fridayEntities: 24,
    fridayProducts: 1,
  });
  assert.equal(config.fridayCron, "59 23 * * *");
  assert.throws(() => getSyncConfig({ ...baseEnv(), IMPORT_CONCURRENCY_IMAGES: "17" }), /between 1 and 16/);
  assert.throws(() => getSyncConfig({ ...baseEnv(), IMPORT_CONCURRENCY_VARIATIONS: "33" }), /between 1 and 32/);
  assert.throws(() => getSyncConfig({ ...baseEnv(), IMPORT_CONCURRENCY_VIDEOS: "3" }), /between 1 and 2/);
  assert.throws(() => getSyncConfig({ ...baseEnv(), WOOCOMMERCE_SYNC_SOURCE_PAGE_CONCURRENCY: "9" }), /between 1 and 8/);
  assert.throws(() => getSyncConfig({ ...baseEnv(), WOOCOMMERCE_SYNC_IDENTITY_SWEEP_PAGES: "26" }), /between 0 and 25/);
  assert.throws(
    () => getSyncConfig({ ...baseEnv(), WOOCOMMERCE_SYNC_FRIDAY_PRODUCT_CONCURRENCY: "7" }),
    /between 1 and 6/,
  );
  assert.throws(
    () => getSyncConfig({ ...baseEnv(), WOOCOMMERCE_IMPORT_PROFILE: "turbo" }),
    /must be one of default, fast/,
  );
});

test("WOOCOMMERCE_IMPORT_PROFILE=fast only changes defaults; explicit env vars still win", () => {
  const fast = getSyncConfig({ ...baseEnv(), WOOCOMMERCE_IMPORT_PROFILE: "fast" });
  assert.deepEqual(fast.concurrency, {
    products: 1, // untouched: only fridayProducts governs the campaign's product-loop concurrency
    images: 8,
    variations: 16,
    videos: 1,
    entities: 24,
    fridayInventory: 32, // already at its ceiling on the default profile — no headroom to raise
    fridayImages: 16,
    fridayEntities: 32,
    fridayProducts: 4,
  });

  // An explicit env var overrides the fast profile's default, same as it overrides the normal default.
  const overridden = getSyncConfig({
    ...baseEnv(),
    WOOCOMMERCE_IMPORT_PROFILE: "fast",
    WOOCOMMERCE_SYNC_FRIDAY_PRODUCT_CONCURRENCY: "2",
  });
  assert.equal(overridden.concurrency.fridayProducts, 2);

  // Profile unset (or "default") reproduces today's exact values.
  assert.deepEqual(getSyncConfig(baseEnv()).concurrency, getSyncConfig({ ...baseEnv(), WOOCOMMERCE_IMPORT_PROFILE: "default" }).concurrency);
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
  assert.deepEqual(calls[2][1], { pattern: "59 23 * * *", tz: "Asia/Tehran" });
  assert.equal(calls[2][2].opts.attempts, 3);
  assert.deepEqual(calls[3][1], { pattern: "30 2 * * *", tz: "Asia/Tehran" });
  assert.equal(calls[3][2].name, JOBS.reconcile);
});

test("nightly cutover cadence is configurable via WOOCOMMERCE_SYNC_FRIDAY_CRON", async () => {
  const calls = [];
  const queue = {
    async upsertJobScheduler(...args) { calls.push(args); },
    async removeJobScheduler() {},
  };
  const config = getSyncConfig({
    ...baseEnv(),
    WOOCOMMERCE_SYNC_ENABLE_FRIDAY: "true",
    WOOCOMMERCE_SYNC_FRIDAY_CRON: "30 1 * * *",
  });
  assert.equal(config.fridayCron, "30 1 * * *");
  await registerSchedulers(queue, config);
  const fridayCall = calls.find((call) => call[2].name === JOBS.friday);
  assert.deepEqual(fridayCall[1], { pattern: "30 1 * * *", tz: "Asia/Tehran" });
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
  // A description-only edit in WooCommerce bumps date_modified_gmt, so the
  // hourly lane re-imports the product even though no watched field changed.
  assert.notEqual(
    productRevision(product),
    productRevision({ ...product, date_modified_gmt: "2026-08-06T00:00:00" }),
  );
  const order = {
    id: 5,
    date_modified_gmt: "2026-08-05T00:00:00",
    status: "processing",
    line_items: [{ id: 7, product_id: 1, variation_id: 3, quantity: 1, total: "10" }],
  };
  assert.equal(orderRevision(order), orderRevision({ ...order }));
  assert.notEqual(orderRevision(order), orderRevision({ ...order, status: "completed" }));
  assert.notEqual(
    orderRevision(order),
    orderRevision({ ...order, shipping: { state: "THR", city: "تهران", address_1: "ولیعصر" } }),
  );
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

test("hourly drain excludes a phoneless customer once instead of failing it", async () => {
  const config = getSyncConfig(baseEnv());
  const pool = { end: async () => undefined };
  const service = new WooSyncService(config, { pool, source: {}, destination: {} });
  const outcomes = [];
  let claims = 0;
  service.state = {
    control: async () => ({ mode: "active", reconciliation_run_id: "accepted", reconciliation_sha256: "a".repeat(64) }),
    assertLease: async () => undefined,
    claimItems: async () => {
      claims += 1;
      return claims === 1
        ? [
          { id: 1, source_type: "customer", source_id: 7 },
          { id: 2, source_type: "customer", source_id: 8 },
          { id: 3, source_type: "customer", source_id: 9 },
        ]
        : [];
    },
    completeItem: async (id) => outcomes.push(["completed", id]),
    failItem: async (id, _token, code) => outcomes.push(["failed", id, code]),
    excludeItem: async (id, _token, code) => outcomes.push(["excluded", id, code]),
  };
  service.source = {
    getCustomer: async (id) => (
      Number(id) === 7
        ? { id: 7, username: "09121234567", billing: {}, shipping: {} }
        : Number(id) === 8
          ? { id: 8, username: "noreply", billing: {}, shipping: {} }
          : Promise.reject(new TypeError("fetch failed"))
    ),
  };
  service.destination = { upsertUser: async () => ({ mode: "created" }) };

  const result = await service.drain("hourly", "hourly-fence");

  assert.deepEqual({ completed: result.completed, failed: result.failed, excluded: result.excluded }, { completed: 1, failed: 1, excluded: 1 });
  assert.deepEqual(outcomes.sort((a, b) => a[1] - b[1]), [
    ["completed", 1],
    ["excluded", 2, "USER_PHONE_INVALID"],
    ["failed", 3, "TYPEERROR:FETCH_FAILED"],
  ]);
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

test("safeErrorCode prefers SCREAMING_SNAKE error.message over Error.name", () => {
  assert.equal(safeErrorCode(new Error("USER_PHONE_INVALID")), "USER_PHONE_INVALID");
  assert.equal(safeErrorCode({ code: "USER_PHONE_SOURCE_CONFLICT" }), "USER_PHONE_SOURCE_CONFLICT");
  assert.equal(safeErrorCode({ payload: { error: "HTTP_404" } }), "HTTP_404");
  // A free-text message keeps its meaning instead of collapsing to the name:
  // 1,975 quarantined customers read a bare `ERROR` and nobody could say why.
  assert.equal(safeErrorCode(new Error("something went wrong")), "ERROR:SOMETHING_WENT_WRONG");
  assert.equal(safeErrorCode(new TypeError("fetch failed")), "TYPEERROR:FETCH_FAILED");
  assert.equal(
    safeErrorCode(new Error("Request failed with status code 502 at https://x.example/api")),
    "ERROR:REQUEST_FAILED_WITH_STATUS_CODE_502_AT_URL",
  );
  // The catalog engine records failures as plain strings; they used to be UNKNOWN.
  assert.equal(safeErrorCode("variation attribute term not found: pa_color"), "VARIATION_ATTRIBUTE_TERM_NOT_FOUND_PA_COLOR");
  assert.equal(safeErrorCode(""), "UNKNOWN");
  assert.equal(safeErrorCode(new Error("")), "ERROR");
  assert.ok(safeErrorCode(new Error("x".repeat(500))).length <= 128);
});

test("fridayScheduledTimestamp prefers repeatable job id fire time over creation timestamp", () => {
  const fireAt = Date.parse("2026-08-10T20:29:00.000Z");
  const createdAt = Date.parse("2026-08-10T13:28:51.900Z");
  assert.equal(
    fridayScheduledTimestamp({
      id: `repeat:sched:woocommerce.friday-cutover:${fireAt}`,
      timestamp: createdAt,
    }),
    fireAt,
  );
  assert.equal(
    fridayScheduledTimestamp({ id: "manual-cutover", timestamp: createdAt, opts: { prevMillis: fireAt } }),
    fireAt,
  );
  assert.equal(fridayScheduledTimestamp({ id: "manual", timestamp: createdAt }), createdAt);
});

test("fullUsersAndWallets skips phoneless customers and continues", async () => {
  const config = getSyncConfig(baseEnv());
  const service = new WooSyncService(config, { pool: { end: async () => undefined }, source: {}, destination: {} });
  const upserted = [];
  service.state = {
    control: async () => ({ mode: "active", reconciliation_run_id: "r1", reconciliation_sha256: "a".repeat(64) }),
  };
  let perIdBalanceCalls = 0;
  service.source = {
    async *customers() {
      yield {
        page: 1,
        rows: [
          { id: 1, billing: { phone: "09121234567" }, shipping: {}, email: "ok@example.com", first_name: "A", last_name: "B" },
          { id: 2, billing: {}, shipping: {}, email: "nophone@example.com", first_name: "C", last_name: "D" },
        ],
      };
    },
    // Bulk list knows nothing about these customers, so both fall back to the
    // per-id endpoint — the path that must survive an incomplete list.
    async *walletUsers() {
      yield { page: 1, rows: [] };
    },
    getWalletBalance: async () => {
      perIdBalanceCalls += 1;
      const error = new Error("NOT_FOUND");
      error.payload = { error: "NOT_FOUND" };
      throw error;
    },
  };
  service.destination = {
    upsertUser: async (payload) => {
      upserted.push(payload);
      return { mode: "created" };
    },
    upsertWallet: async () => {
      throw new Error("wallet should not be required when balance is missing");
    },
  };

  const result = await service.fullUsersAndWallets();
  assert.equal(result.users, 1);
  assert.equal(result.wallets, 0);
  // A phoneless account is excluded by decision, not counted as a failure.
  assert.equal(result.failed, 0);
  assert.equal(result.excluded, 1);
  assert.equal(upserted.length, 1);
  assert.equal(upserted[0].sourceId, "1");
  assert.equal(upserted[0].phone, "+989121234567");
  assert.equal(perIdBalanceCalls, 1, "a bulk-list miss must fall back to the per-id balance endpoint");
  assert.equal(result.wallet.fallbacks, 1);
  assert.equal(result.wallet.missing, 1);
});

test("friday finishes completed-with-exceptions when users fail but orders succeed", async () => {
  const config = getSyncConfig(baseEnv());
  const service = new WooSyncService(config, { pool: { end: async () => undefined }, source: {}, destination: {} });
  const finished = [];
  const steps = [];
  const scheduledAt = Date.now() - 60_000;
  service.withLease = async (_name, action) => action("friday-fence");
  service.state = {
    control: async () => ({ mode: "active", reconciliation_run_id: "r1", reconciliation_sha256: "a".repeat(64) }),
    startCampaign: async () => ({ status: "running" }),
    campaignStep: async (_key, _token, step, metrics = {}) => {
      steps.push({ step, metrics });
    },
    finishCampaign: async (_key, _token, status, errorCode = null) => {
      finished.push({ status, errorCode });
    },
    markMissedCampaign: async () => null,
  };
  service.drain = async () => ({ completed: 0, failed: 0, skipped: false });
  service.fullUsersAndWallets = async () => ({ users: 1, wallets: 0, failed: 3 });
  service.fullOrders = async () => ({ completed: 2, failed: 0 });
  const engineFactoryCalls = [];
  service.createCatalogEngine = (campaignConfig) => {
    engineFactoryCalls.push(campaignConfig.concurrency);
    return {
      runSync: async ({ scope }) => ({
        toJSON: () => ({ failures: scope === "full-sync" ? [{ wcId: 9 }] : [], processed: 3393, durationMs: 1000 }),
        hasFailures: () => scope === "full-sync",
        durationMs: () => 1,
      }),
    };
  };

  const result = await service.friday(scheduledAt);

  assert.equal(result.status, "completed-with-exceptions");
  assert.equal(result.catalog.failed, 1);
  assert.deepEqual(result.identities, { users: 1, wallets: 0, failed: 3 });
  assert.deepEqual(result.orders, { completed: 2, failed: 0 });
  assert.deepEqual(finished, [{ status: "completed-with-exceptions", errorCode: null }]);
  assert.equal(steps.some((entry) => entry.step === "catalog-full"), true);
  assert.equal(steps.some((entry) => entry.step === "users-wallets"), true);
  assert.equal(steps.some((entry) => entry.step === "orders"), true);

  // Every stage's product-loop concurrency comes from fridayProducts (not the
  // plain `entities`/hourly `products: 1` default) — this is what actually lets
  // "stock" and "price" parallelize; CatalogEngine forces catalog-full back to 1.
  assert.equal(engineFactoryCalls.length, 3);
  for (const concurrency of engineFactoryCalls) assert.equal(concurrency.products, config.concurrency.fridayProducts);

  // Timing instrumentation: every stage has a duration, plus a total, and the
  // finalizing step carries both durations and throughput for later inspection.
  for (const key of ["newProducts", "catalogFull", "stock", "price", "usersWallets", "orders", "totalMs"]) {
    assert.equal(typeof result.durationsMs[key], "number");
  }
  assert.equal(result.durationsMs.totalMs >= 0, true);
  const finalizing = steps.find((entry) => entry.step === "finalizing");
  assert.ok(finalizing, "expected a finalizing campaignStep call");
  assert.deepEqual(Object.keys(finalizing.metrics).sort(), ["durationsMs", "orders", "throughput", "variant", "wallet"]);
  assert.equal(finalizing.metrics.variant, "full");
  // Throughput denominators are the same wall-clock stage timers as durationsMs
  // (not report.durationMs()), so either a finite rate or null (0-duration stage
  // in this near-instant mock) is correct — never Infinity/NaN.
  for (const key of Object.keys(finalizing.metrics.throughput)) {
    const value = finalizing.metrics.throughput[key];
    assert.equal(value === null || Number.isFinite(value), true, `${key} should be finite or null, got ${value}`);
  }
});

function activeService(overrides = {}) {
  const config = getSyncConfig(overrides.env || baseEnv());
  const service = new WooSyncService(config, {
    pool: { end: async () => undefined },
    source: {},
    destination: {},
  });
  service.state = {
    control: async () => ({ mode: "active", reconciliation_run_id: "r1", reconciliation_sha256: "a".repeat(64) }),
  };
  return service;
}

test("campaign wallets come from the bulk list, not one balance request per customer", async () => {
  const service = activeService();
  const wallets = [];
  service.source = {
    async *walletUsers() {
      yield { page: 1, rows: [{ id: 1, balance: 5, base_currency: "IRT" }, { id: 2, balance: 0 }] };
    },
    async *customers() {
      yield {
        page: 1,
        rows: [
          { id: 1, billing: { phone: "09121234567" } },
          { id: 2, billing: { phone: "09121234568" } },
        ],
      };
    },
    getWalletBalance: async () => {
      throw new Error("the bulk list covered this customer; no per-id read may happen");
    },
  };
  service.destination = {
    upsertUser: async () => ({ mode: "created" }),
    upsertWallet: async (payload) => { wallets.push(payload); return { mode: "created" }; },
  };

  const result = await service.fullUsersAndWallets();

  assert.equal(result.users, 2);
  assert.equal(result.wallets, 2);
  assert.equal(result.wallet.fallbacks, 0);
  assert.equal(result.wallet.unique, 2);
  // TeraWallet reports toman (base_currency IRT); Strapi Balance is rial.
  assert.equal(wallets.find((w) => w.userSourceId === "1").balanceRial, "50");
});

test("the identity stage hands the balance snapshot to the caller without putting it in metrics", async () => {
  const service = activeService();
  service.source = {
    async *walletUsers() { yield { page: 1, rows: [{ id: 1, balance: 3 }] }; },
    async *customers() { yield { page: 1, rows: [] }; },
  };
  service.destination = { upsertUser: async () => ({}), upsertWallet: async () => ({}) };
  const handoff = {};
  const result = await service.fullUsersAndWallets({ handoff });
  assert.equal(handoff.balances.get("1"), 3);
  assert.ok(!("balances" in result), "the summary is serialized into campaign metrics; keep the map out of it");
});

test("the rehearsal wallet check counts divergence between the bulk list and the per-id endpoint", async () => {
  const service = activeService();
  service.source = {
    async *walletUsers() {
      yield { page: 1, rows: [{ id: 1, balance: 5 }, { id: 2, balance: 9 }] };
    },
    async *customers() { yield { page: 1, rows: [] }; },
    // id 1 agrees (different literal, same written value); id 2 disagrees.
    getWalletBalance: async (id) => (String(id) === "1" ? { balance: "5.0" } : { balance: 11 }),
  };
  service.destination = { upsertUser: async () => ({}), upsertWallet: async () => ({}) };

  const result = await service.fullUsersAndWallets({ verify: true });

  assert.equal(result.wallet.verified, 2);
  assert.equal(result.wallet.divergence, 1, "only a difference in the value actually written counts");
});

function variantHarness() {
  const service = activeService();
  const steps = [];
  const scopes = [];
  const finished = [];
  service.withLease = async (_name, action) => action("fence");
  service.state = {
    control: async () => ({ mode: "active", reconciliation_run_id: "r1", reconciliation_sha256: "a".repeat(64) }),
    startCampaign: async () => ({ status: "running" }),
    campaignStep: async (_key, _token, step) => { steps.push(step); },
    finishCampaign: async (_key, _token, status, errorCode = null) => { finished.push({ status, errorCode }); },
    markMissedCampaign: async () => null,
  };
  service.drain = async () => ({ completed: 0, failed: 0, skipped: false });
  service.fullUsersAndWallets = async () => ({ users: 1, wallets: 1, failed: 0, wallet: {} });
  service.fullOrders = async () => ({ completed: 1, failed: 0 });
  service.createCatalogEngine = () => ({
    runSync: async ({ scope }) => {
      scopes.push(scope);
      return { toJSON: () => ({ failures: [], processed: 10, durationMs: 1 }), hasFailures: () => false, durationMs: () => 1 };
    },
  });
  return { service, steps, scopes, finished };
}

test("the full variant keeps the historical stage sequence", async () => {
  const { service, steps, scopes } = variantHarness();
  const result = await service.friday(Date.now() - 60_000, { variant: "full" });
  assert.equal(result.variant, "full");
  assert.deepEqual(scopes, ["full-sync", "stock", "price"]);
  assert.deepEqual(steps, [
    "new-products", "catalog-full", "inventory", "inventory-complete",
    "users-wallets", "orders", "finalizing",
  ]);
});

test("the cutover variant overlaps catalog with identities and runs inventory last", async () => {
  const { service, steps, scopes } = variantHarness();
  const result = await service.friday(Date.now() - 60_000, { variant: "cutover" });
  assert.equal(result.variant, "cutover");
  // One combined inventory pass instead of separate stock and price walks.
  assert.deepEqual(scopes, ["full-sync", "inventory-instock"]);
  assert.deepEqual(steps, [
    "new-products", "catalog-full+users-wallets", "orders", "inventory", "inventory-complete", "finalizing",
  ]);
  // Stock is the value that oversells when stale, so it is written after
  // users and orders are already durable.
  assert.ok(steps.indexOf("inventory") > steps.indexOf("orders"));
  assert.equal(typeof result.durationsMs.inventory, "number");
  // The overlap hides the critical path unless each branch times itself.
  assert.equal(typeof result.durationsMs.catalogFull, "number");
  assert.equal(typeof result.durationsMs.usersWallets, "number");
  assert.equal(typeof result.durationsMs.catalogFullUsersWallets, "number");
});

test("the cutover variant defaults from config so the worker needs no extra wiring", async () => {
  const { service, scopes } = variantHarness();
  service.config = getSyncConfig({ ...baseEnv(), WOOCOMMERCE_SYNC_CAMPAIGN_VARIANT: "cutover" });
  await service.friday(Date.now() - 60_000);
  assert.deepEqual(scopes, ["full-sync", "inventory-instock"]);
});

test("fullOrders preload resolves provisioned customers and the variation index once", async () => {
  // The campaign-only path: unexercised until the first real run otherwise.
  const config = getSyncConfig(baseEnv());
  const service = new WooSyncService(config, {
    pool: { end: async () => undefined, query: async () => ({ rows: [{ source_key: "7" }] }) },
    source: {
      async *orders() {
        yield { page: 1, rows: [{ id: 1, customer_id: 7, date_modified_gmt: "2026-01-01T00:00:00" }] };
      },
    },
    destination: {},
  });
  let indexBuilds = 0;
  service._catalogEngine = {
    repo: {
      buildExternalIndex: async () => { indexBuilds += 1; return new Map([["4", { id: 10004 }]]); },
    },
  };
  service.state = { async recordOrderOutcome() { return {}; } };
  const seen = [];
  service.syncOrderRow = async (_row, options) => {
    seen.push(options);
    return { mode: "created", hasSoftIssues: false };
  };

  const result = await service.fullOrders({ concurrency: 2, preload: true });

  assert.deepEqual(result, { completed: 1, failed: 0, excluded: 0, softIssues: 0, fetched: 1 });
  assert.equal(indexBuilds, 1, "the variation index is enumerated once for the whole stage");
  assert.equal(seen[0].mappedCustomers.has("7"), true);
  assert.equal(seen[0].variationIndex.get("4").id, 10004);
  assert.equal(seen[0].order.id, 1, "the list row is passed through instead of being refetched");
});

test("fullOrders without preload behaves exactly as before", async () => {
  const config = getSyncConfig(baseEnv());
  const service = new WooSyncService(config, {
    pool: {
      end: async () => undefined,
      query: async () => { throw new Error("no mapping query without preload"); },
    },
    source: { async *orders() { yield { page: 1, rows: [{ id: 1, date_modified_gmt: "2026-01-01T00:00:00" }] }; } },
    destination: {},
  });
  service.state = { async recordOrderOutcome() { return {}; } };
  const seen = [];
  service.syncOrderRow = async (_row, options) => { seen.push(options); return { mode: "created" }; };
  await service.fullOrders({ concurrency: 1 });
  assert.equal(seen[0].mappedCustomers, null);
  assert.equal(seen[0].variationIndex, null);
});

test("a failing identity branch waits for the catalog branch before failing the campaign", async () => {
  // Promise.all would finish the campaign and release the lease while the
  // catalog engine kept writing to Strapi for another hour.
  const { service, finished } = variantHarness();
  let catalogSettled = false;
  service.createCatalogEngine = () => ({
    runSync: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      catalogSettled = true;
      return { toJSON: () => ({ failures: [], processed: 1, durationMs: 1 }), hasFailures: () => false, durationMs: () => 1 };
    },
  });
  service.fullUsersAndWallets = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw Object.assign(new Error("IDENTITY_BOOM"), { code: "IDENTITY_BOOM" });
  };

  await assert.rejects(service.friday(Date.now() - 60_000, { variant: "cutover" }), /IDENTITY_BOOM/);
  assert.equal(catalogSettled, true, "the campaign must not be torn down mid-write");
  assert.deepEqual(finished, [{ status: "failed", errorCode: "IDENTITY_BOOM" }]);
});

test("an inventory failure still raises the historical FRIDAY_STOCK_HAS_FAILURES code", async () => {
  const { service } = variantHarness();
  service.createCatalogEngine = () => ({
    runSync: async ({ scope }) => ({
      toJSON: () => ({ failures: scope === "inventory-instock" ? [{ wcId: 1 }] : [], processed: 1, durationMs: 1 }),
      hasFailures: () => scope === "inventory-instock",
      durationMs: () => 1,
    }),
  });
  await assert.rejects(
    service.friday(Date.now() - 60_000, { variant: "cutover" }),
    (error) => error.code === "FRIDAY_STOCK_HAS_FAILURES",
  );
});

test("finalizeActiveCampaign marks a campaign failed when the process dies out-of-band", async () => {
  // The 2026-09-12 gap: the process was killed by an unhandled rejection, so
  // friday()'s own catch never ran and the row sat at `running` — a NON-terminal
  // status, which startCampaign's ON CONFLICT resets, so the next scheduled
  // campaign silently re-ran everything instead of skipping.
  const calls = [];
  const service = Object.create(WooSyncService.prototype);
  service.activeCampaign = { campaignKey: "friday:2026-09-12", token: "tok-1" };
  service.state = {
    finishCampaign: async (...args) => { calls.push(args); },
  };

  assert.equal(await service.finalizeActiveCampaign("PROCESS_UNHANDLED_REJECTION"), true);
  assert.deepEqual(calls, [["friday:2026-09-12", "tok-1", "failed", "PROCESS_UNHANDLED_REJECTION"]]);

  // Idempotent: a second handler firing during the same death must not re-write.
  assert.equal(await service.finalizeActiveCampaign("PROCESS_UNCAUGHT_EXCEPTION"), false);
  assert.equal(calls.length, 1);
});

test("finalizeActiveCampaign never throws from an already-failing path", async () => {
  const service = Object.create(WooSyncService.prototype);
  service.activeCampaign = { campaignKey: "friday:2026-09-12", token: "stale" };
  service.state = {
    finishCampaign: async () => {
      throw Object.assign(new Error("fence rejected"), { code: "WOOCOMMERCE_SYNC_FENCE_REJECTED" });
    },
  };
  // A lost fence is expected (another process may have taken over); it must be
  // reported as "not marked", never propagated into the dying process.
  assert.equal(await service.finalizeActiveCampaign(), false);

  const idle = Object.create(WooSyncService.prototype);
  idle.activeCampaign = null;
  assert.equal(await idle.finalizeActiveCampaign(), false);
});

test("describeError unwraps the cause chain that hides the real transport code", () => {
  // The 2026-09-12 log showed only "TypeError: fetch failed" for a long while —
  // useless. The reason lives on cause.code.
  const crash = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
  });
  const described = describeError(crash);
  assert.match(described, /TypeError: fetch failed/);
  assert.match(described, /UND_ERR_CONNECT_TIMEOUT/);

  // Must terminate on a self-referential chain rather than spin.
  const looping = new Error("a");
  looping.cause = looping;
  assert.ok(describeError(looping).length > 0);

  assert.equal(describeError(null), "unknown error");
});
