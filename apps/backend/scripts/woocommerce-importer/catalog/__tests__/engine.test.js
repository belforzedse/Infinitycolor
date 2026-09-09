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
    migration: { controlToken: "m".repeat(48) },
  };
}

/**
 * Build an engine whose network layers are stubbed against the fixtures.
 * @param {object} [opts]
 * @param {boolean} [opts.withExisting=false] preload indexes so existing entities are present
 * @param {"Active"|"InActive"|"Scheduled"} [opts.existingProductStatus="InActive"]
 */
function makeEngine(opts = {}) {
  const engine = new CatalogEngine(makeConfig(), noopLogger, { environment: "local" });
  const calls = {
    upserts: [],
    stockUpserts: [],
    puts: [],
    sizeHelpers: [],
    publicationCommands: [],
    editorialPrepares: [],
    editorialFinalizes: [],
  };
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
    if (endpoint === "/products") {
      existingProductIds.forEach((id) => map.set(id, {
        id: Number(id) + 10000,
        attributes: { Status: opts.existingProductStatus || "InActive" },
      }));
    }
    if (endpoint === "/product-variations") existingVariationIds.forEach((id) => map.set(id, { id: Number(id) + 10000 }));
    return map;
  };
  engine.repo.fetchCategoryEditorialSnapshot = async () => [
    {
      id: 10005,
      title: "کیف",
      slug: "kif",
      externalId: "5",
      externalSource: "woocommerce",
      editorial: opts.existingEditorial?.[5] || null,
    },
    {
      id: 10009,
      title: "اکسسوری",
      slug: "acc",
      externalId: "9",
      externalSource: "woocommerce",
      editorial: opts.existingEditorial?.[9] || null,
    },
  ];
  engine.repo.prepareCategoryEditorial = async (payload) => {
    calls.editorialPrepares.push(payload);
    return { mode: "prepared", id: 40000 + calls.editorialPrepares.length };
  };
  engine.repo.finalizeCategoryEditorial = async (payload) => {
    calls.editorialFinalizes.push(payload);
    return { mode: "published", published: payload.entries.length };
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
  engine.repo.changeProductPublication = async (productId, externalId, intent) => {
    calls.publicationCommands.push({ productId, externalId, intent });
    return {
      Status: intent.action === "publish-now"
        ? "Active"
        : intent.action === "schedule"
          ? "Scheduled"
          : "InActive",
    };
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

test("category-editorial validates, localizes audio, prepares drafts, and finalizes one exact batch", async () => {
  const engine = makeEngine();
  const audioHash = "a".repeat(64);
  engine.woo.fetchAllCategories = async () => [
    {
      id: 5,
      name: "کیف",
      slug: "kif",
      parent: 0,
      description:
        '<h1>راهنمای کیف</h1><p>مقدمه</p>[audio mp3="https://cdn.example.com/guide.mp3"][/audio]<p><a href="/shop/acc/">اکسسوری</a></p>',
    },
    { id: 9, name: "اکسسوری", slug: "acc", parent: 5, description: "<h2>اکسسوری زنانه</h2>" },
  ];
  engine.media.inspectAudioUrl = async () => ({
    buffer: Buffer.from("ID3fixture"),
    sha256: audioHash,
    bytes: 10,
    name: `wc-category-audio-${audioHash}.mp3`,
    mime: "audio/mpeg",
  });
  let audioWrites = 0;
  engine.media.syncInspectedAudio = async () => {
    audioWrites += 1;
    return { id: 61, sha256: audioHash, status: "uploaded" };
  };

  const report = await engine.runSync({ dryRun: false, scope: "category-editorial" });

  assert.equal(report.entities.categoryEditorial.created, 2);
  assert.equal(report.entities.categoryEditorial.successful, 2);
  assert.equal(report.categoryAudio.uploaded, 1);
  assert.equal(audioWrites, 1);
  assert.equal(engine._calls.editorialPrepares.length, 2);
  assert.equal(engine._calls.editorialFinalizes.length, 1);
  assert.match(engine._calls.editorialPrepares[0].data.Content, /href="\/plp\/category\/acc"/);
  assert.equal(engine._calls.editorialPrepares[0].data.Paragraph, "مقدمه");
  assert.equal(engine._calls.editorialFinalizes[0].batchId, report.categoryEditorial.batchId);

  const preparedBySource = new Map(
    engine._calls.editorialPrepares.map((entry, index) => [String(entry.sourceId), {
      id: 40001 + index,
      importBatchId: report.categoryEditorial.batchId,
      importedSourceHash: entry.sourceHash,
      isPublished: true,
      audio: entry.audio ? { id: entry.audio.id } : null,
    }]),
  );
  engine.repo.fetchCategoryEditorialSnapshot = async () => [
    { id: 10005, title: "کیف", slug: "kif", externalId: "5", externalSource: "woocommerce", editorial: preparedBySource.get("5") },
    { id: 10009, title: "اکسسوری", slug: "acc", externalId: "9", externalSource: "woocommerce", editorial: preparedBySource.get("9") },
  ];
  engine.media.syncInspectedAudio = async () => {
    throw new Error("idempotent import must not upload audio");
  };
  const second = await engine.runSync({ dryRun: false, scope: "category-editorial" });
  assert.equal(second.entities.categoryEditorial.skipped, 2);
  assert.equal(second.categoryAudio.uploaded, 0);
  assert.equal(second.categoryAudio.reused, 0);
  assert.equal(audioWrites, 1);
});

test("category-editorial performs no destination writes when audio validation fails", async () => {
  const engine = makeEngine();
  engine.woo.fetchAllCategories = async () => [{
    id: 5,
    name: "کیف",
    slug: "kif",
    parent: 0,
    description: '<p>مقدمه</p>[audio mp3="http://127.0.0.1/private.mp3"]',
  }];
  engine.media.inspectAudioUrl = async () => {
    throw new Error("CATEGORY_EDITORIAL_AUDIO_URL_UNSAFE:private-host");
  };
  const report = await engine.runSync({ dryRun: false, scope: "category-editorial" });
  assert.equal(report.categoryAudio.failed, 1);
  assert.equal(engine._calls.editorialPrepares.length, 0);
  assert.equal(engine._calls.editorialFinalizes.length, 0);
});

test("hourly product rows bypass a full Woo product scan and never process categories or media", async () => {
  const engine = makeEngine();
  engine.woo.iterateProducts = async function* () {
    throw new Error("full product scan must not start");
  };
  const report = await engine.runSync({
    dryRun: true,
    scope: "product-no-media",
    sourceProducts: [products[0]],
  });
  assert.equal(report.entities.products.created, 1);
  assert.equal(report.entities.categories.created, 0);
  assert.equal(report.media.uploaded, 0);
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

test("publication: existing Active product ignores a future Woo schedule", async () => {
  const futureProduct = {
    ...products[0],
    status: "future",
    date_created_gmt: "2099-01-01T08:30:00",
  };
  const engine = makeEngine({
    products: [futureProduct],
    withExisting: true,
    existingProductStatus: "Active",
  });
  const store = new CatalogRunStore(engine.config.catalog.trackingDirAbs);

  await engine.runSync({
    scope: "no-media",
    runStore: store,
    runId: "active-future-protection",
  });

  assert.deepEqual(engine._calls.publicationCommands, []);
  assert.equal(
    store.getRun("active-future-protection").items["product:101"].metrics.publicationIssue,
    "scheduled-update-unsupported",
  );
});

test("publication: a due Woo future product publishes after catalog writes", async () => {
  const dueProduct = {
    ...products[0],
    status: "future",
    date_created_gmt: "2020-01-01T08:30:00",
  };
  const engine = makeEngine({ products: [dueProduct] });

  await engine.runSync({ scope: "no-media" });

  assert.equal(engine._calls.publicationCommands.length, 1);
  assert.equal(engine._calls.publicationCommands[0].externalId, 101);
  assert.equal(engine._calls.publicationCommands[0].intent.action, "publish-now");
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
  engine.media.syncProductMedia = async () => ({
    coverId: 1,
    galleryIds: [2, 3],
    counts: { uploaded: 1, reused: 2, failed: 0 },
    complete: true,
  });
  engine.repo.http.get = async (url) => {
    const id = Number(String(url).split("/").pop());
    return {
      data: {
        data: {
          id,
          attributes: {
            CoverImage: { data: { id: 1 } },
            Media: { data: [{ id: 2 }, { id: 3 }] },
          },
        },
      },
    };
  };
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

test("full-sync: existing product with cover keeps its media (no media write)", async () => {
  const engine = makeEngine({ products: [products[0]] }); // product 101
  // Existing product already has a cover (gallery optional for preserve).
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
    return { coverId: 7, galleryIds: [8, 9], counts: { uploaded: 3, reused: 0, failed: 0 }, complete: true };
  };

  const report = await engine.runSync({ dryRun: false, scope: "full-sync" });

  assert.equal(mediaCalls, 0, "media import must be skipped");
  assert.equal(engine._calls.puts.filter((p) => p.url.startsWith("/products/")).length, 0);
  assert.equal(report.media.skippedExisting, 1);
  assert.equal(report.media.uploaded, 0);
  // Product fields are still refreshed.
  assert.equal(engine._calls.upserts.filter((u) => u.endpoint === "/products").length, 1);
});

test("full-sync: existing product missing the cover gets media backfilled", async () => {
  const engine = makeEngine({ products: [products[0]] });
  engine.repo.buildExternalIndex = async (endpoint) => {
    const map = new Map();
    if (endpoint === "/products") {
      map.set("101", { id: 10101, attributes: { CoverImage: { data: null }, Media: { data: [] } } });
    }
    return map;
  };
  engine.media.syncProductMedia = async () => ({
    coverId: 7,
    galleryIds: [8, 9],
    counts: { uploaded: 3, reused: 0, failed: 0 },
    complete: true,
  });
  engine.repo.http.get = async () => ({
    data: {
      data: {
        id: 10101,
        attributes: {
          CoverImage: { data: { id: 7 } },
          Media: { data: [{ id: 8 }, { id: 9 }] },
        },
      },
    },
  });

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
  engine.media.syncProductMedia = async () => ({
    coverId: 7,
    galleryIds: [8, 9],
    counts: { uploaded: 3, reused: 0, failed: 0 },
    complete: true,
  });
  engine.repo.http.get = async () => ({
    data: {
      data: {
        id: 10101,
        attributes: {
          CoverImage: { data: { id: 7 } },
          Media: { data: [{ id: 8 }, { id: 9 }] },
        },
      },
    },
  });

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
  }, token);

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

function simulatedCrash(message) {
  const error = new Error(message);
  error.code = "CATALOG_SIMULATED_CRASH";
  return error;
}

function expireLease(store, runId) {
  const control = store.readControl(runId);
  control.lock.heartbeatAt = "2000-01-01T00:00:00.000Z";
  store.writeControl(runId, control);
}

test("restart after destination product success re-upserts only the running product by external_id", async () => {
  const first = makeEngine({ products: [products[0]] });
  const store = new CatalogRunStore(first.config.catalog.trackingDirAbs, { lockStaleMs: 1 });
  await assert.rejects(() => first.runSync({
    scope: "no-media",
    runStore: store,
    runId: "crash-product-write",
    crashHooks: { afterProductWrite() { throw simulatedCrash("after product write"); } },
  }), /after product write/);
  assert.equal(store.getRun("crash-product-write").items["product:101"].status, "running");
  expireLease(store, "crash-product-write");

  const resumed = makeEngine({ products: [products[0]], withExisting: true });
  await resumed.runSync({ runStore: store, runId: "crash-product-write", resume: true, retryFailed: true });
  const externalIds = [
    ...first._calls.upserts,
    ...resumed._calls.upserts,
  ].filter((call) => call.endpoint === "/products").map((call) => call.externalId);
  assert.deepEqual(new Set(externalIds), new Set(["101"]));
  assert.equal(store.getRun("crash-product-write").items["product:101"].status, "completed");
});

test("restart after variation success before stock safely retries variation then orders stock completion first", async () => {
  const first = makeEngine({ products: [products[0]] });
  const store = new CatalogRunStore(first.config.catalog.trackingDirAbs, { lockStaleMs: 1 });
  let crashed = false;
  await assert.rejects(() => first.runSync({
    scope: "no-media",
    runStore: store,
    runId: "crash-variation-write",
    crashHooks: { afterVariationWrite() { if (!crashed) { crashed = true; throw simulatedCrash("after variation write"); } } },
  }), /after variation write/);
  expireLease(store, "crash-variation-write");

  const resumed = makeEngine({ products: [products[0]], withExisting: true });
  await resumed.runSync({ runStore: store, runId: "crash-variation-write", resume: true, retryFailed: true });
  const run = store.getRun("crash-variation-write");
  assert.equal(run.items["stock:201"].status, "completed");
  assert.equal(run.items["variation:201"].status, "completed");
  assert.ok(new Date(run.items["stock:201"].completedAt) <= new Date(run.items["variation:201"].completedAt));
});

test("restart after stock success skips completed stock while finishing its running variation", async () => {
  const first = makeEngine({ products: [products[0]] });
  const store = new CatalogRunStore(first.config.catalog.trackingDirAbs, { lockStaleMs: 1 });
  let crashed = false;
  await assert.rejects(() => first.runSync({
    scope: "no-media",
    runStore: store,
    runId: "crash-stock-commit",
    crashHooks: {
      afterStockCommitBeforeVariationComplete() {
        if (!crashed) { crashed = true; throw simulatedCrash("after stock commit"); }
      },
    },
  }), /after stock commit/);
  assert.equal(store.getRun("crash-stock-commit").items["stock:201"].status, "completed");
  expireLease(store, "crash-stock-commit");

  const resumed = makeEngine({ products: [products[0]], withExisting: true });
  await resumed.runSync({ runStore: store, runId: "crash-stock-commit", resume: true, retryFailed: true });
  assert.equal(resumed._calls.stockUpserts.filter((call) => call.externalId === "201").length, 0);
  assert.equal(store.getRun("crash-stock-commit").items["variation:201"].status, "completed");
});

test("completed parent with a failed child traverses children without product or media writes", async () => {
  const engine = makeEngine({ products: [products[0]], withExisting: true });
  const store = new CatalogRunStore(engine.config.catalog.trackingDirAbs);
  store.createRun({
    runId: "completed-parent-failed-child",
    command: "sync:no-media",
    environment: "local",
    strapiBaseUrl: "http://localhost:1337/api",
    options: { scope: "no-media", dryRun: false, limit: "all" },
  });
  const token = store.acquireLock("completed-parent-failed-child");
  store.beginItem("completed-parent-failed-child", "product:101", { entity: "products", wcId: 101 }, token);
  store.completeItem("completed-parent-failed-child", "product:101", { strapiId: 10101 }, token);
  store.beginItem("completed-parent-failed-child", "variation:201", { entity: "variations", wcId: 201, parentWcId: 101 }, token);
  store.failItem("completed-parent-failed-child", "variation:201", {
    entity: "variations", wcId: 201, parentWcId: 101, stage: "sync-variation", error: "temporary",
  }, token);
  store.setStatus("completed-parent-failed-child", "resumable", {}, token);
  store.releaseLock("completed-parent-failed-child", token);
  let mediaCalls = 0;
  engine.media.syncProductMedia = async () => { mediaCalls += 1; return { coverId: null, galleryIds: [], counts: { uploaded: 0, reused: 0, failed: 0 } }; };

  await engine.runSync({
    runStore: store,
    runId: "completed-parent-failed-child",
    resume: true,
    retryFailed: true,
  });
  assert.equal(engine._calls.upserts.filter((call) => call.endpoint === "/products").length, 0);
  assert.equal(mediaCalls, 0);
  assert.equal(store.getRun("completed-parent-failed-child").items["product:101"].attempts, 1);
  assert.equal(store.getRun("completed-parent-failed-child").items["variation:201"].status, "completed");
});
