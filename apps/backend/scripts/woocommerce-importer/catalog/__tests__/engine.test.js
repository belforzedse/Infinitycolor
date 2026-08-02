"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CatalogEngine, sortCategoriesByHierarchy } = require("../engine");
const { CatalogRunStore } = require("../lib/runStore");
const products = require("../fixtures/products.json");
const variations = require("../fixtures/variations.json");

const noopLogger = { info() {}, debug() {}, warn() {}, error() {}, success() {} };

function makeConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-engine-"));
  return {
    woocommerce: { baseUrl: "https://example.com/wp-json/wc/v3", auth: { consumerKey: "k", consumerSecret: "s" } },
    strapi: { baseUrl: "http://localhost:1337/api", usePublicAccess: false, auth: { token: "t" } },
    duplicateTracking: { storageDir: dir },
    import: {
      currency: { multiplier: 1 },
      statusMappings: { product: { publish: "Active", draft: "InActive" } },
      images: { enableUpload: false },
      videos: { enableUpload: false },
      defaults: { variationAttributes: { color: { title: "خاکستری روشن", colorCode: "#CCCCCC" } } },
    },
    catalog: { maxRetries: 1, baseRetryDelay: 1, perPage: 100, defaultInStockCount: 9999, allowHttpMedia: true, trackingDirAbs: dir },
  };
}

/**
 * Build an engine whose network layers are stubbed against the fixtures.
 * @param {object} [opts]
 * @param {boolean} [opts.withExisting=false] preload indexes so existing entities are present
 */
function makeEngine(opts = {}) {
  const engine = new CatalogEngine(makeConfig(), noopLogger, { environment: "local" });
  const calls = { upserts: [], stockUpserts: [], puts: [], sizeHelpers: [] };
  let generatedId = 30000;

  // Every variation id that "exists" in Strapi (variable variations + simple synth ids).
  const existingVariationIds = opts.withExisting ? ["201", "202", "203", "102", "103"] : [];
  const existingProductIds = opts.withExisting ? ["101", "102", "103"] : [];

  engine.preflight = async () => {};
  engine.repo.preloadAttributes = async () => {};
  engine.repo.preloadProductTags = async () => {};
  engine.repo.inspectProductTags = () => ({ created: 0, unchanged: 0 });
  engine.repo.syncProductTags = async () => ({ ids: [], counters: { created: 0, unchanged: 0 } });
  engine.repo.buildExternalIndex = async (endpoint) => {
    const map = new Map();
    if (endpoint === "/products") existingProductIds.forEach((id) => map.set(id, { id: Number(id) + 10000 }));
    if (endpoint === "/product-variations") existingVariationIds.forEach((id) => map.set(id, { id: Number(id) + 10000 }));
    return map;
  };
  engine.repo.upsert = async ({ endpoint, externalId, payload }) => {
    calls.upserts.push({ endpoint, externalId, payload });
    const numericExternalId = Number(externalId);
    return {
      id: Number.isFinite(numericExternalId) ? numericExternalId + 10000 : generatedId++,
      mode: "created",
    };
  };
  engine.repo.upsertStock = async ({ externalId, variationId }) => {
    calls.stockUpserts.push({ externalId, variationId });
    return "created";
  };
  engine.repo.syncProductSizeHelper = async (productId, helperMatrix) => {
    calls.sizeHelpers.push({ productId, helperMatrix });
    return helperMatrix ? "created" : "unchanged";
  };
  engine.repo.resolveAttributeId = async () => 1;
  engine.repo.http = { put: async (url, body) => { calls.puts.push({ url, body }); return {}; } };

  engine.woo.fetchAllCategories = async () => [
    { id: 5, name: "کیف", slug: "kif", parent: 0 },
    { id: 9, name: "اکسسوری", slug: "acc", parent: 5 },
  ];
  engine.woo.iterateProducts = async function* () { for (const p of opts.products || products) yield p; };
  engine.woo.fetchGlobalAttributeRegistry = async () => new Map([
    [1, {
      id: 1,
      name: "Color",
      slug: "color",
      termsByName: new Map([
        ["قرمز", { id: 11, name: "قرمز", slug: "red", menu_order: 0 }],
        ["آبی", { id: 12, name: "آبی", slug: "blue", menu_order: 1 }],
      ]),
    }],
    [2, {
      id: 2,
      name: "Size",
      slug: "size",
      termsByName: new Map([
        ["m", { id: 21, name: "M", slug: "m", menu_order: 0 }],
        ["l", { id: 22, name: "L", slug: "l", menu_order: 1 }],
      ]),
    }],
  ]);
  engine.woo.fetchAllVariations = async (productId) =>
    variations.filter((variation) => variation.parent_id === productId);
  engine.woo.iterateVariations = async function* (productId) {
    for (const v of variations.filter((x) => x.parent_id === productId)) yield v;
  };

  engine._calls = calls;
  return engine;
}

test("sortCategoriesByHierarchy: parents before children, orphans included", () => {
  const cats = [{ id: 3, parent: 1 }, { id: 1, parent: 0 }, { id: 2, parent: 99 }];
  const sorted = sortCategoriesByHierarchy(cats).map((c) => c.id);
  assert.ok(sorted.indexOf(1) < sorted.indexOf(3));
  assert.ok(sorted.includes(2));
  assert.equal(sorted.length, 3);
});

test("dry-run category sampling honors the requested cap", async () => {
  const engine = makeEngine();
  const report = await engine.runSync({ dryRun: true, scope: "categories", categoryLimit: 1 });
  assert.equal(report.entities.categories.created, 1);
});

test("pilot category selection includes only selected categories and their parents", async () => {
  const engine = makeEngine();
  const report = await engine.runSync({
    dryRun: true,
    scope: "categories",
    onlyCategoryExternalIds: new Set([9]),
  });
  assert.equal(report.entities.categories.created, 2);

  const parentOnlyEngine = makeEngine();
  const parentOnly = await parentOnlyEngine.runSync({
    dryRun: true,
    scope: "categories",
    onlyCategoryExternalIds: new Set([5]),
  });
  assert.equal(parentOnly.entities.categories.created, 1);
});

test("full dry-run: counts creates, synthesizes simple variations, flags missing price", async () => {
  const engine = makeEngine();
  const report = await engine.runSync({ dryRun: true, skipMedia: true });
  assert.equal(report.entities.products.created, 3);
  // 201, 202, 203 (203 inherits parent price), simple-102 synth = 4 created; simple-103 (no price) fails.
  assert.equal(report.entities.variations.created, 4);
  assert.equal(report.entities.variations.failed, 1);
  assert.deepEqual(report.failures.filter((f) => f.stage === "price").map((f) => f.wcId), [103]);
});

test("full sync: upserts categories + products + variations + stock, records mappings", async () => {
  const engine = makeEngine();
  const report = await engine.runSync({ dryRun: false, scope: "no-media" });
  assert.equal(report.entities.categories.created, 2);
  assert.equal(report.entities.products.created, 3);
  assert.equal(report.entities.variations.created, 4);
  assert.equal(report.entities.stocks.created, 4);
  assert.equal(engine._calls.sizeHelpers.length, 3);
  assert.equal(engine.mapping.getStrapiId("products", 101), 10101);
  assert.equal(engine.mapping.getStrapiId("variations", 201), 10201);
});

test("full sync: mirrors WooCommerce color attributes exactly", async () => {
  const engine = makeEngine();
  await engine.runSync({ dryRun: false, scope: "no-media" });

  const variationUpserts = new Map(
    engine._calls.upserts
      .filter((call) => call.endpoint === "/product-variations")
      .map((call) => [call.externalId, call.payload]),
  );

  assert.equal(variationUpserts.get("201").product_variation_color, 1);
  assert.equal(variationUpserts.get("202").product_variation_color, 1);
  assert.equal(variationUpserts.get("203").product_variation_color, 1);
  assert.equal(variationUpserts.get("102").product_variation_color, null);
});

test("full sync: child category becomes product_main_category when parent is also assigned", async () => {
  // Category 9 (اکسسوری) has parent 5 (کیف). Product 101 has both.
  // The child (9 → strapiId 10009) must be main; the parent (5 → 10005) goes to other.
  const engine = makeEngine();
  await engine.runSync({ dryRun: false, scope: "no-media" });

  const productUpserts = new Map(
    engine._calls.upserts
      .filter((u) => u.endpoint === "/products")
      .map((u) => [u.externalId, u.payload]),
  );

  assert.equal(productUpserts.get("101").product_main_category, 10009); // child is main
  assert.ok(productUpserts.get("101").product_other_categories.includes(10005)); // parent is other
});

test("full sync: syncs WooCommerce size guide matrix to product-size-helper", async () => {
  const productWithGuide = {
    ...products[1],
    id: 150,
    meta_data: [
      {
        key: "product_size_guide",
        value: JSON.stringify([
          ["Size", "Chest"],
          ["M", 42],
          ["L", null],
        ]),
      },
    ],
  };
  const engine = makeEngine({ products: [productWithGuide] });
  const report = await engine.runSync({ scope: "no-media" });

  assert.deepEqual(engine._calls.sizeHelpers, [
    {
      productId: 10150,
      helperMatrix: [
        ["Size", "Chest"],
        ["M", "42"],
        ["L", ""],
      ],
    },
  ]);
  assert.equal(report.entities.sizeHelpers.created, 1);
});

test("stock scope: writes ONLY stock, only for existing variations, no product/variation upserts", async () => {
  const engine = makeEngine({ withExisting: true });
  const report = await engine.runSync({ scope: "stock" });

  // No product or variation record writes at all.
  assert.equal(engine._calls.upserts.length, 0);
  // Stock upserted for each existing variation (201,202,203 + simple 102,103) = 5.
  assert.equal(engine._calls.stockUpserts.length, 5);
  assert.equal(report.entities.stocks.created, 5);
  assert.equal(report.entities.products.created, 0);
  assert.equal(report.entities.variations.created, 0);
});

test("price scope: PUTs only {Price,DiscountPrice} on existing variations, creates nothing", async () => {
  const engine = makeEngine({ withExisting: true });
  const report = await engine.runSync({ scope: "price" });

  // Nothing created (no upsert), no stock writes.
  assert.equal(engine._calls.upserts.length, 0);
  assert.equal(engine._calls.stockUpserts.length, 0);
  assert.equal(engine._calls.sizeHelpers.length, 0);

  // Price PUTs only touch /product-variations and only carry price fields.
  const pricePuts = engine._calls.puts.filter((p) => p.url.startsWith("/product-variations/"));
  assert.ok(pricePuts.length >= 4);
  for (const put of pricePuts) {
    assert.deepEqual(Object.keys(put.body.data).sort(), ["DiscountPrice", "Price"]);
  }
  assert.equal(report.entities.variations.updated, pricePuts.length);
});

test("media scope: attaches media to existing products, creates nothing", async () => {
  const engine = makeEngine({ withExisting: true });
  // Stub media resolution to return ids so an attach PUT happens.
  engine.media.syncProductMedia = async () => ({ coverId: 1, galleryIds: [2, 3], counts: { uploaded: 1, reused: 2, failed: 0 } });
  const report = await engine.runSync({ scope: "media" });

  assert.equal(engine._calls.upserts.length, 0);
  assert.equal(engine._calls.stockUpserts.length, 0);
  const productPuts = engine._calls.puts.filter((p) => p.url.startsWith("/products/"));
  assert.equal(productPuts.length, 3); // one per existing product
  for (const put of productPuts) {
    assert.equal(put.body.data.CoverImage, 1);
    assert.deepEqual(put.body.data.Media, [2, 3]);
  }
  assert.equal(report.media.uploaded, 3);
  assert.equal(report.media.reused, 6);
});

test("full-sync: existing product with cover + gallery keeps its media (no media write)", async () => {
  const engine = makeEngine({ products: [products[0]] }); // product 101
  // Existing product already has BOTH a cover and a gallery.
  engine.repo.buildExternalIndex = async (endpoint) => {
    const map = new Map();
    if (endpoint === "/products") {
      map.set("101", { id: 10101, attributes: { CoverImage: { data: { id: 1 } }, Media: { data: [{ id: 2 }] } } });
    }
    return map;
  };
  let mediaCalls = 0;
  engine.media.syncProductMedia = async () => {
    mediaCalls += 1;
    return { coverId: 7, galleryIds: [8, 9], counts: { uploaded: 3, reused: 0, failed: 0 } };
  };

  const report = await engine.runSync({ dryRun: false, scope: "full-sync" });

  assert.equal(mediaCalls, 0, "media import must be skipped");
  assert.equal(engine._calls.puts.filter((p) => p.url.startsWith("/products/")).length, 0);
  assert.equal(report.media.skippedExisting, 1);
  assert.equal(report.media.uploaded, 0);
  // Product fields are still refreshed.
  assert.equal(engine._calls.upserts.filter((u) => u.endpoint === "/products").length, 1);
});

test("full-sync: existing product missing the gallery gets media backfilled", async () => {
  const engine = makeEngine({ products: [products[0]] });
  engine.repo.buildExternalIndex = async (endpoint) => {
    const map = new Map();
    if (endpoint === "/products") {
      map.set("101", { id: 10101, attributes: { CoverImage: { data: { id: 1 } }, Media: { data: [] } } });
    }
    return map;
  };
  engine.media.syncProductMedia = async () => ({ coverId: 7, galleryIds: [8, 9], counts: { uploaded: 3, reused: 0, failed: 0 } });

  const report = await engine.runSync({ dryRun: false, scope: "full-sync" });

  const productPuts = engine._calls.puts.filter((p) => p.url.startsWith("/products/"));
  assert.equal(productPuts.length, 1);
  assert.equal(productPuts[0].url, "/products/10101");
  assert.equal(productPuts[0].body.data.CoverImage, 7);
  assert.deepEqual(productPuts[0].body.data.Media, [8, 9]);
  assert.equal(report.media.skippedExisting, 0);
  assert.equal(report.media.uploaded, 3);
});

test("full-sync: new product is created and its media imported", async () => {
  const engine = makeEngine({ products: [products[0]] });
  engine.repo.buildExternalIndex = async () => new Map(); // nothing exists yet
  engine.media.syncProductMedia = async () => ({ coverId: 7, galleryIds: [8, 9], counts: { uploaded: 3, reused: 0, failed: 0 } });

  const report = await engine.runSync({ dryRun: false, scope: "full-sync" });

  // Product created via upsert (stub returns id = externalId + 10000).
  assert.equal(engine._calls.upserts.filter((u) => u.endpoint === "/products").length, 1);
  const productPuts = engine._calls.puts.filter((p) => p.url.startsWith("/products/"));
  assert.equal(productPuts.length, 1);
  assert.equal(productPuts[0].url, "/products/10101");
  assert.deepEqual(productPuts[0].body.data.Media, [8, 9]);
  assert.equal(report.media.skippedExisting, 0);
  assert.equal(report.media.uploaded, 3);
});

test("onlyExisting scopes skip entities that were never imported", async () => {
  const engine = makeEngine({ withExisting: false }); // nothing exists
  const report = await engine.runSync({ scope: "stock" });
  assert.equal(engine._calls.stockUpserts.length, 0);
  assert.equal(report.entities.products.skipped, 3); // all products skipped (not imported)
});

test("sync can start after a Woo external id for old-run continuation", async () => {
  const engine = makeEngine({ products: [products[0], products[1]] });
  const store = new CatalogRunStore(engine.config.catalog.trackingDirAbs);

  const report = await engine.runSync({
    scope: "no-media",
    startAfterExternalId: products[0].id,
    runStore: store,
    runId: "tracked-start-after",
  });

  const productUpserts = engine._calls.upserts.filter((call) => call.endpoint === "/products");
  assert.equal(report.entities.products.skipped, 1);
  assert.equal(report.entities.products.created, 1);
  assert.deepEqual(productUpserts.map((call) => call.externalId), [String(products[1].id)]);
  assert.equal(store.getRun("tracked-start-after").options.startAfterExternalId, products[0].id);
});

test("tracked sync: records a completed run with per-item state", async () => {
  const engine = makeEngine({ products: [products[0]] });
  const store = new CatalogRunStore(engine.config.catalog.trackingDirAbs);

  const report = await engine.runSync({ scope: "no-media", runStore: store, runId: "tracked-success" });
  const run = store.getRun("tracked-success");

  assert.equal(report.hasFailures(), false);
  assert.equal(run.status, "completed");
  assert.equal(run.items["category:5"].status, "completed");
  assert.equal(run.items["product:101"].status, "completed");
  assert.equal(run.items["variation:201"].status, "completed");
  assert.equal(run.items["stock:201"].status, "completed");
  assert.equal(run.totals.failedItems, 0);
});

test("tracked categories: interrupted run resumes without reprocessing completed items", async () => {
  const engine = makeEngine({ products: [] });
  const store = new CatalogRunStore(engine.config.catalog.trackingDirAbs);
  let checks = 0;

  await assert.rejects(
    () => engine.runSync({
      scope: "categories",
      runStore: store,
      runId: "tracked-interrupted",
      shouldCancel: async () => {
        checks += 1;
        return checks > 1;
      },
    }),
    /cancel/,
  );

  const interrupted = store.getRun("tracked-interrupted");
  assert.equal(interrupted.status, "cancelled");
  assert.equal(interrupted.items["category:5"].status, "completed");
  assert.equal(engine._calls.upserts.filter((call) => call.endpoint === "/product-categories").length, 1);

  const resumed = makeEngine({ products: [] });
  resumed.config.duplicateTracking.storageDir = engine.config.duplicateTracking.storageDir;
  resumed.config.catalog.trackingDirAbs = engine.config.catalog.trackingDirAbs;
  await resumed.runSync({ runStore: store, runId: "tracked-interrupted", resume: true });

  const categoryUpserts = resumed._calls.upserts.filter((call) => call.endpoint === "/product-categories");
  assert.equal(categoryUpserts.length, 1);
  assert.equal(categoryUpserts[0].externalId, "9");
  assert.equal(store.getRun("tracked-interrupted").status, "completed");
});

test("tracked sync: failed rows are inspectable and retryFailed retries them", async () => {
  const brokenProduct = { ...products[2], price: "", regular_price: "", sale_price: "" };
  const fixedProduct = { ...products[2], price: "120000", regular_price: "120000" };
  const engine = makeEngine({ products: [brokenProduct] });
  const store = new CatalogRunStore(engine.config.catalog.trackingDirAbs);

  const first = await engine.runSync({ scope: "no-media", runStore: store, runId: "tracked-retry" });
  assert.equal(first.hasFailures(), true);
  assert.equal(store.getRun("tracked-retry").status, "resumable");
  assert.equal(store.getRun("tracked-retry").items["variation:103"].status, "failed");

  const retryEngine = makeEngine({ products: [fixedProduct] });
  retryEngine.config.duplicateTracking.storageDir = engine.config.duplicateTracking.storageDir;
  retryEngine.config.catalog.trackingDirAbs = engine.config.catalog.trackingDirAbs;
  const second = await retryEngine.runSync({
    runStore: store,
    runId: "tracked-retry",
    resume: true,
    retryFailed: true,
  });

  assert.equal(second.hasFailures(), false);
  assert.equal(store.getRun("tracked-retry").items["variation:103"].status, "completed");
  assert.equal(store.getRun("tracked-retry").status, "completed");
});

test("tracked sync: duplicate source rows are skipped by stable product key", async () => {
  const engine = makeEngine({ products: [products[0], products[0]] });
  const store = new CatalogRunStore(engine.config.catalog.trackingDirAbs);

  const report = await engine.runSync({ scope: "no-media", runStore: store, runId: "tracked-duplicates" });

  assert.equal(report.entities.products.created, 1);
  assert.equal(report.entities.products.skipped, 1);
  assert.equal(engine._calls.upserts.filter((call) => call.endpoint === "/products").length, 1);
});

test("tracked sync: concurrent lock protection rejects a second worker", () => {
  const engine = makeEngine({ products: [] });
  const store = new CatalogRunStore(engine.config.catalog.trackingDirAbs);
  store.createRun({
    runId: "tracked-lock",
    command: "sync:categories",
    environment: "local",
    strapiBaseUrl: "http://localhost:1337/api",
    options: { scope: "categories", dryRun: false, limit: "all" },
  });
  const token = store.acquireLock("tracked-lock");

  assert.throws(() => store.acquireLock("tracked-lock"), /already locked/);
  store.releaseLock("tracked-lock", token);
});

test("tracked sync: stale running locks are treated as resumable", () => {
  const engine = makeEngine({ products: [] });
  const store = new CatalogRunStore(engine.config.catalog.trackingDirAbs, { lockStaleMs: 1 });
  store.createRun({
    runId: "tracked-stale-running",
    command: "sync:no-media",
    environment: "local",
    strapiBaseUrl: "http://localhost:1337/api",
    options: { scope: "no-media", dryRun: false, limit: "all" },
  });
  const token = store.acquireLock("tracked-stale-running");
  store.updateRun("tracked-stale-running", (run) => {
    run.lock.heartbeatAt = "2000-01-01T00:00:00.000Z";
    return run;
  });

  assert.equal(store.isResumable(store.getRun("tracked-stale-running")), true);
  assert.ok(store.listRuns({ statuses: ["resumable"] }).some((run) => run.id === "tracked-stale-running"));
  store.releaseLock("tracked-stale-running", token);
});

test("run store retries transient Windows rename locks", () => {
  const engine = makeEngine({ products: [] });
  const store = new CatalogRunStore(engine.config.catalog.trackingDirAbs);
  const originalRenameSync = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith("catalog-runs.json") && attempts < 2) {
      attempts += 1;
      const error = new Error("operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalRenameSync(from, to);
  };
  try {
    store.createRun({
      runId: "tracked-rename-retry",
      command: "sync:no-media",
      environment: "local",
      strapiBaseUrl: "http://localhost:1337/api",
      options: { scope: "no-media", dryRun: false, limit: "all" },
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(attempts, 2);
  assert.equal(store.getRun("tracked-rename-retry").id, "tracked-rename-retry");
});

test("tracked sync: validation errors mark item failed without killing the run", async () => {
  const engine = makeEngine({ products: [{ ...products[0], id: 999, name: "" }] });
  const store = new CatalogRunStore(engine.config.catalog.trackingDirAbs);

  const report = await engine.runSync({ scope: "no-media", runStore: store, runId: "tracked-validation" });
  const run = store.getRun("tracked-validation");

  assert.equal(report.entities.products.failed, 1);
  assert.equal(run.status, "resumable");
  assert.equal(run.items["product:999"].status, "failed");
  assert.match(run.items["product:999"].error, /missing name/);
});
