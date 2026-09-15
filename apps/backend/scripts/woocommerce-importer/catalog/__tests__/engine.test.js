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
  engine.verifyVariationAttributeRelations = async () => ({ ok: true });

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
    {
      id: 9,
      name: "اکسسوری",
      slug: "acc",
      parent: 5,
      description: "<h2>اکسسوری زنانه</h2><p>کیف و کمربند و شال</p>",
    },
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
      importSource: "woocommerce-category-description",
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
  // The server owns the decision: an importer-owned row whose hash still
  // matches, already published, is reported unchanged and written to by nobody.
  engine.repo.prepareCategoryEditorial = async (payload) => {
    engine._calls.editorialPrepares.push(payload);
    return {
      mode: "skipped",
      reason: "unchanged",
      id: preparedBySource.get(String(payload.sourceId)).id,
      isPublished: true,
      importBatchId: payload.batchId,
      importedSourceHash: payload.sourceHash,
    };
  };
  const preparesBefore = engine._calls.editorialPrepares.length;
  const second = await engine.runSync({ dryRun: false, scope: "category-editorial" });
  // A row this importer wrote and nobody has touched since is "unchanged", which
  // is a different fact from "skipped" and is reported as one.
  assert.equal(second.entities.categoryEditorial.unchanged, 2);
  assert.equal(second.categoryEditorialOutcomes.unchanged, 2);
  assert.equal(second.entities.categoryEditorial.created, 0);
  assert.equal(second.categoryAudio.uploaded, 0);
  assert.equal(second.categoryAudio.reused, 0);
  assert.equal(audioWrites, 1);
  // A clean rerun writes nothing at all — not even a finalize that would bust
  // the storefront cache for pages that did not change.
  assert.equal(engine._calls.editorialFinalizes.length, 1);
  assert.equal(engine._calls.editorialPrepares.length - preparesBefore, 2, "the server still decides");
});

test("category-editorial finishes a batch that was interrupted before finalize", async () => {
  const engine = makeEngine();
  engine.woo.fetchAllCategories = async () => [{
    id: 5,
    name: "کیف",
    slug: "kif",
    parent: 0,
    description: "<h1>راهنمای کیف</h1><p>متن کیف</p>",
  }];
  // The row a previous run prepared: same content, never published, and
  // stamped with that run's batch id rather than this run's.
  engine.repo.fetchCategoryEditorialSnapshot = async () => [{
    id: 10005,
    title: "کیف",
    slug: "kif",
    externalId: "5",
    externalSource: "woocommerce",
    editorial: {
      id: 40001,
      importSource: "woocommerce-category-description",
      importBatchId: "category-seo-aaaaaaaa",
      importedSourceHash: null,
      isPublished: false,
      audio: null,
    },
  }];
  engine.repo.prepareCategoryEditorial = async (payload) => {
    engine._calls.editorialPrepares.push(payload);
    // The server adopts the stranded row into this batch.
    return {
      mode: "skipped",
      reason: "unchanged",
      id: 40001,
      isPublished: false,
      importBatchId: payload.batchId,
      importedSourceHash: payload.sourceHash,
      adopted: true,
    };
  };

  const report = await engine.runSync({ dryRun: false, scope: "category-editorial" });
  assert.equal(report.categoryEditorialOutcomes.unchanged, 1);
  assert.equal(engine._calls.editorialFinalizes.length, 1, "the stranded row is finalized, not orphaned");
  assert.equal(engine._calls.editorialFinalizes[0].entries[0].editorialId, 40001);
});

test("category-editorial propagates a source edit into the row it already owns", async () => {
  const engine = makeEngine();
  engine.woo.fetchAllCategories = async () => [{
    id: 5,
    name: "کیف",
    slug: "kif",
    parent: 0,
    description: "<h1>راهنمای کیف</h1><p>متن تازه پس از ویرایش در ووکامرس</p>",
  }];
  engine.repo.fetchCategoryEditorialSnapshot = async () => [{
    id: 10005,
    title: "کیف",
    slug: "kif",
    externalId: "5",
    externalSource: "woocommerce",
    editorial: {
      id: 40001,
      importSource: "woocommerce-category-description",
      importBatchId: "category-seo-00000000",
      importedSourceHash: "b".repeat(64),
      isPublished: true,
      audio: null,
    },
  }];
  engine.repo.prepareCategoryEditorial = async (payload) => {
    engine._calls.editorialPrepares.push(payload);
    return { mode: "updated", id: 40001, isPublished: true };
  };

  const report = await engine.runSync({ dryRun: false, scope: "category-editorial" });
  assert.equal(report.entities.categoryEditorial.updated, 1);
  assert.equal(report.categoryEditorialOutcomes.update, 1);
  assert.equal(engine._calls.editorialPrepares.length, 1);
  assert.match(engine._calls.editorialPrepares[0].data.Content, /متن تازه/);
  // The updated row is finalized with the rest of the batch.
  assert.equal(engine._calls.editorialFinalizes.length, 1);
  assert.equal(engine._calls.editorialFinalizes[0].entries[0].editorialId, 40001);
});

test("category-editorial leaves a row somebody else wrote alone and never fetches its audio", async () => {
  const engine = makeEngine();
  engine.woo.fetchAllCategories = async () => [{
    id: 5,
    name: "کیف",
    slug: "kif",
    parent: 0,
    description: '<p>مقدمه</p>[audio mp3="https://cdn.example.com/guide.mp3"][/audio]',
  }];
  engine.repo.fetchCategoryEditorialSnapshot = async () => [{
    id: 10005,
    title: "کیف",
    slug: "kif",
    externalId: "5",
    externalSource: "woocommerce",
    editorial: { id: 40001, importSource: null, importBatchId: null, importedSourceHash: null, isPublished: true },
  }];
  engine.media.inspectAudioUrl = async () => {
    throw new Error("a manual row must not cost a source fetch");
  };

  const report = await engine.runSync({ dryRun: false, scope: "category-editorial" });
  assert.equal(report.categoryEditorialOutcomes.manual, 1);
  assert.equal(report.entities.categoryEditorial.skipped, 1);
  assert.equal(engine._calls.editorialPrepares.length, 0);
});

test("category-editorial does not create a row from a source description that is only a heading", async () => {
  const engine = makeEngine();
  engine.woo.fetchAllCategories = async () => [
    { id: 5, name: "کیف", slug: "kif", parent: 0, description: "<h2>کیف زنانه</h2>" },
    { id: 9, name: "شال", slug: "shawl", parent: 0, description: "<h2>شال</h2><p>شال نخی و ابریشمی</p>" },
  ];

  const report = await engine.runSync({ dryRun: true, scope: "category-editorial" });
  assert.equal(report.categoryEditorialOutcomes["title-only"], 1);
  assert.equal(report.categoryEditorialOutcomes.create, 1);
  assert.equal(report.entities.categoryEditorial.created, 1);
});

test("--ids narrows a category-editorial-only run to the named categories", async () => {
  const engine = makeEngine();
  engine.woo.fetchAllCategories = async () => [
    { id: 5, name: "کیف", slug: "kif", parent: 0, description: "<p>مقدمه کیف</p>" },
    { id: 9, name: "شال", slug: "shawl", parent: 0, description: "<p>شال نخی و ابریشمی</p>" },
  ];

  const report = await engine.runSync({
    dryRun: false,
    scope: "category-editorial",
    onlyCategoryExternalIds: ["9"],
  });
  assert.equal(report.entities.categoryEditorial.created, 1);
  assert.deepEqual(engine._calls.editorialPrepares.map((entry) => entry.sourceId), ["9"]);
});

test("category-editorial isolates one unreachable audio file from the rest of the batch", async () => {
  const engine = makeEngine();
  engine.woo.fetchAllCategories = async () => [
    {
      id: 5,
      name: "کیف",
      slug: "kif",
      parent: 0,
      description: '<p>مقدمه کیف</p>[audio mp3="https://cdn.example.com/broken.mp3"][/audio]',
    },
    { id: 9, name: "شال", slug: "shawl", parent: 0, description: "<p>شال نخی و ابریشمی</p>" },
  ];
  engine.media.inspectAudioUrl = async () => {
    throw new Error("CATEGORY_EDITORIAL_AUDIO_UNREACHABLE");
  };

  const report = await engine.runSync({ dryRun: false, scope: "category-editorial" });
  assert.equal(report.categoryAudio.failed, 1);
  assert.equal(report.entities.categoryEditorial.failed, 1);
  // The category that was fine is still imported and finalized.
  assert.equal(report.entities.categoryEditorial.created, 1);
  assert.deepEqual(engine._calls.editorialPrepares.map((entry) => entry.sourceId), ["9"]);
  assert.equal(engine._calls.editorialFinalizes.length, 1);
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

test("skipStock: the product loop still writes everything except stock", async () => {
  // The products+variations+media path has never run with stock off — every
  // stock-bearing scope had stock:true — so exercise it end to end, not just
  // the flag resolution.
  const engine = makeEngine();
  const report = await engine.runSync({ dryRun: false, scope: "no-media", skipStock: true });
  assert.equal(report.entities.categories.created, 2);
  assert.equal(report.entities.products.created, 3);
  assert.equal(report.entities.variations.created, 4);
  const stocks = report.entities.stocks || {};
  assert.equal(stocks.created || 0, 0, "no stock rows created");
  assert.equal(stocks.updated || 0, 0, "no stock rows updated");
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

test("stock scope: IMPORT_CONCURRENCY_PRODUCTS > 1 still processes every product pulled from the async Woo generator", async () => {
  // Regression guard: syncProducts' concurrent path must *pull* from
  // woo.iterateProducts() (an async generator) rather than materializing it
  // with Array.from, which silently yields zero items and would make this
  // report an empty, "successful" run.
  const productCount = 12;
  const base = products.find((p) => p.id === 102);
  const synthetic = Array.from({ length: productCount }, (_, i) => ({ ...base, id: 900 + i }));
  const engine = makeEngine({ products: synthetic });
  engine.repo.buildExternalIndex = async (endpoint) => {
    const map = new Map();
    // The stock scope's onlyExisting check requires both the product and its
    // variation to already exist in Strapi.
    if (endpoint === "/products" || endpoint === "/product-variations") {
      synthetic.forEach((p) => map.set(String(p.id), { id: p.id + 10000, attributes: { Status: "Active" } }));
    }
    return map;
  };
  engine.config.catalog.concurrency = { products: 4 };

  const report = await engine.runSync({ scope: "stock" });

  assert.equal(report.processed, productCount);
  assert.equal(engine._calls.stockUpserts.length, productCount);
  assert.equal(report.entities.stocks.created, productCount);
});

test("full-sync scope forces product concurrency back to 1 (shared tag/attribute caches) even when configured higher", async () => {
  const infoLines = [];
  const engine = makeEngine();
  engine.logger = { ...noopLogger, info: (msg) => infoLines.push(msg) };
  engine.config.catalog.concurrency = { products: 5 };

  const report = await engine.runSync({ dryRun: false, scope: "no-media" });

  // Identical to the concurrency=1 baseline above — the clamp doesn't change
  // correctness, only whether products run serially or in a bounded pool.
  assert.equal(report.entities.categories.created, 2);
  assert.equal(report.entities.products.created, 3);
  assert.equal(report.entities.variations.created, 4);
  assert.equal(report.entities.stocks.created, 4);
  assert.ok(infoLines.some((line) => /forcing serial product processing/.test(line)));
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

/**
 * The "inventory-instock" gate must be a pure optimisation: it may skip work
 * when WooCommerce and Strapi already agree the product is empty, and must
 * never write a stock value it did not read from WooCommerce. WooCommerce's
 * variable-parent stock_status is known to under-report real stock, so a
 * disagreement has to cost a fetch, not a zeroing.
 */
test("inventory-instock skips the variation fetch for an out-of-stock product Strapi already has at zero", async () => {
  const engine = makeEngine({ withExisting: true, products: [{ ...products[0], stock_status: "outofstock" }] });
  engine.woo.fetchAllVariations = async () => {
    throw new Error("out-of-stock product already at zero must not be fetched");
  };
  engine.repo.buildExternalIndex = async (endpoint) => {
    const map = new Map();
    if (endpoint === "/products") map.set("101", { id: 10101 });
    if (endpoint === "/product-variations") {
      map.set("201", { id: 10201 });
      map.set("202", { id: 10202 });
    }
    if (endpoint === "/product-stocks") {
      map.set("stock_201", { id: 20201, attributes: { Count: 0 } });
      map.set("stock_202", { id: 20202, attributes: { Count: 0 } });
    }
    return map;
  };

  const report = await engine.runSync({ dryRun: false, scope: "inventory-instock" });

  assert.equal(report.stockGate.examined, 1);
  assert.equal(report.stockGate.verifiedSkipped, 1);
  assert.equal(report.stockGate.staleNonZero, 0);
  assert.equal(engine._calls.stockUpserts.length, 0, "nothing may be written for a verified-empty product");
  assert.equal(engine._calls.puts.length, 0);
  assert.equal(report.entities.products.skipped, 1);
});

test("inventory-instock re-reads WooCommerce when Strapi still shows stock for an out-of-stock product", async () => {
  // The dangerous direction: Woo says outofstock, Strapi holds 5. Blind-zeroing
  // here would destroy live inventory, so the product takes the full path and
  // the value written comes from Woo's own stock_quantity.
  const engine = makeEngine({ withExisting: true, products: [{ ...products[0], stock_status: "outofstock" }] });
  let fetched = 0;
  engine.woo.fetchAllVariations = async (productId) => {
    fetched += 1;
    return variations.filter((v) => v.parent_id === productId && [201, 202].includes(v.id));
  };
  engine.repo.buildExternalIndex = async (endpoint) => {
    const map = new Map();
    if (endpoint === "/products") map.set("101", { id: 10101 });
    if (endpoint === "/product-variations") {
      map.set("201", { id: 10201 });
      map.set("202", { id: 10202 });
    }
    if (endpoint === "/product-stocks") {
      map.set("stock_201", { id: 20201, attributes: { Count: 5 } });
      map.set("stock_202", { id: 20202, attributes: { Count: 0 } });
    }
    return map;
  };
  const written = [];
  engine.repo.upsertStock = async ({ externalId, count }) => {
    written.push({ externalId, count });
    return "updated";
  };

  const report = await engine.runSync({ dryRun: false, scope: "inventory-instock" });

  assert.equal(fetched, 1, "a disagreement must cost a fetch");
  assert.equal(report.stockGate.staleNonZero, 1);
  assert.equal(report.stockGate.verifiedSkipped, 0);
  // Values come from the fixtures' real stock_quantity (201 => 5, 202 => 0),
  // never from the stock_status flag.
  assert.deepEqual(
    written.sort((a, b) => a.externalId.localeCompare(b.externalId)),
    [{ externalId: "stock_201", count: 5 }, { externalId: "stock_202", count: 0 }],
  );
});

test("inventory-instock leaves in-stock products on the normal path and writes price and stock from one fetch", async () => {
  const engine = makeEngine({ withExisting: true, products: [products[1]] }); // 102: simple, instock
  let fetched = 0;
  engine.woo.fetchAllVariations = async () => {
    fetched += 1;
    return [];
  };
  const written = [];
  engine.repo.upsertStock = async ({ externalId, count }) => {
    written.push({ externalId, count });
    return "updated";
  };

  const report = await engine.runSync({ dryRun: false, scope: "inventory-instock" });

  assert.equal(report.stockGate.examined, 0, "in-stock products never enter the gate");
  assert.equal(fetched, 0, "a simple product has no variations to fetch");
  assert.deepEqual(written, [{ externalId: "stock_102", count: 7 }]);
  // price-only variation write goes through PUT, from the same pass.
  assert.equal(engine._calls.puts.length, 1);
  assert.match(engine._calls.puts[0].url, /\/product-variations\/10102$/);
});

test("the stock gate stays off for injected rows, narrowed runs and dry runs", async () => {
  // The hourly drain injects specific products; narrowing means the caller
  // already chose them. Second-guessing either would silently drop work.
  const outOfStock = { ...products[0], stock_status: "outofstock" };
  for (const [label, options] of [
    ["injected rows", { sourceProducts: [outOfStock] }],
    ["narrowed by id", { onlyExternalIds: ["101"] }],
    ["limited", { limit: 1 }],
    ["dry run", { dryRun: true }],
  ]) {
    const engine = makeEngine({ withExisting: true, products: [outOfStock] });
    let fetched = 0;
    engine.woo.fetchAllVariations = async () => {
      fetched += 1;
      return variations.filter((v) => [201, 202].includes(v.id));
    };
    engine.repo.buildExternalIndex = async (endpoint) => {
      const map = new Map();
      if (endpoint === "/products") map.set("101", { id: 10101 });
      if (endpoint === "/product-variations") {
        map.set("201", { id: 10201 });
        map.set("202", { id: 10202 });
      }
      if (endpoint === "/product-stocks") {
        map.set("stock_201", { id: 20201, attributes: { Count: 0 } });
        map.set("stock_202", { id: 20202, attributes: { Count: 0 } });
      }
      return map;
    };
    const report = await engine.runSync({ dryRun: false, scope: "inventory-instock", ...options });
    assert.equal(report.stockGate, null, `${label}: gate must be inactive`);
    assert.equal(fetched, 1, `${label}: variations must still be fetched`);
  }
});

test("a bare stock row created earlier in the same run reads as unknown, not as zero", async () => {
  // Rows repo.upsert created during this run are { id } with no attributes.
  // Treating that as a confirmed zero would skip a product we know nothing about.
  const engine = makeEngine({ withExisting: true, products: [{ ...products[0], stock_status: "outofstock" }] });
  let fetched = 0;
  engine.woo.fetchAllVariations = async () => {
    fetched += 1;
    return variations.filter((v) => [201, 202].includes(v.id));
  };
  engine.repo.buildExternalIndex = async (endpoint) => {
    const map = new Map();
    if (endpoint === "/products") map.set("101", { id: 10101 });
    if (endpoint === "/product-variations") {
      map.set("201", { id: 10201 });
      map.set("202", { id: 10202 });
    }
    if (endpoint === "/product-stocks") {
      map.set("stock_201", { id: 20201 }); // bare: no attributes
      map.set("stock_202", { id: 20202, attributes: { Count: 0 } });
    }
    return map;
  };

  const report = await engine.runSync({ dryRun: false, scope: "inventory-instock" });

  assert.equal(report.stockGate.verifiedSkipped, 0);
  assert.equal(report.stockGate.staleNonZero, 1);
  assert.equal(fetched, 1);
});

test("content-refresh updates variation relations but never Price/DiscountPrice", async () => {
  const engine = makeEngine({ withExisting: true, products: [products[0]] });
  const report = await engine.runSync({ scope: "content-refresh" });

  const variationWrites = engine._calls.upserts.filter((c) => c.endpoint === "/product-variations");
  assert.ok(variationWrites.length > 0, "expected variation writes");
  for (const call of variationWrites) {
    assert.equal("Price" in call.payload, false, `Price sent for ${call.externalId}`);
    assert.equal("DiscountPrice" in call.payload, false, `DiscountPrice sent for ${call.externalId}`);
    // The relation half of the record still goes out.
    assert.ok(call.payload.product, `missing product relation for ${call.externalId}`);
    assert.ok(call.payload.SKU, `missing SKU for ${call.externalId}`);
  }
  // No stock row is touched, and the price-only PUT path is not the one taken.
  assert.equal(engine._calls.stockUpserts.length, 0);
  assert.equal(engine._calls.puts.filter((c) => c.url.startsWith("/product-variations/")).length, 0);
  assert.equal(report.hasFailures(), false);
});

test("content-refresh writes the product record and its gallery", async () => {
  const engine = makeEngine({ withExisting: true, products: [products[0]] });
  await engine.runSync({ scope: "content-refresh" });

  const productWrites = engine._calls.upserts.filter((c) => c.endpoint === "/products");
  assert.equal(productWrites.length, 1);
  // Descriptions are the point of the scope; the rest of the record rides along.
  assert.ok("Description" in productWrites[0].payload);
  assert.ok(productWrites[0].payload.Title);
});

test("content-refresh never creates a product that was never imported", async () => {
  const engine = makeEngine({ withExisting: false, products: [products[0]] });
  const report = await engine.runSync({ scope: "content-refresh" });

  // Without the hoisted onlyExisting guard this scope would create the product
  // (and, with stock off, leave it visible with no stock row).
  assert.equal(engine._calls.upserts.filter((c) => c.endpoint === "/products").length, 0);
  assert.equal(engine._calls.upserts.filter((c) => c.endpoint === "/product-variations").length, 0);
  assert.equal(report.entities.products.skipped, 1);
});

test("content-refresh skips a variation Strapi never imported rather than creating it", async () => {
  const engine = makeEngine({ withExisting: true, products: [products[0]] });
  const baseIndex = engine.repo.buildExternalIndex;
  engine.repo.buildExternalIndex = async (endpoint, params) => {
    const map = await baseIndex(endpoint, params);
    if (endpoint === "/product-variations") map.delete("201");
    return map;
  };

  const report = await engine.runSync({ scope: "content-refresh" });
  const written = engine._calls.upserts
    .filter((c) => c.endpoint === "/product-variations")
    .map((c) => c.externalId);

  // "no-price" only strips the money from rows that exist; it is `onlyExisting`
  // that decides an absent row is skipped, not created at a price this scope
  // has no business setting.
  assert.equal(written.includes("201"), false);
  assert.deepEqual(written.sort(), ["202", "203"]);
  assert.equal(report.entities.variations.skipped, 1);
});

test("content-refresh demands the frozen editorial manifest on a production apply", async () => {
  const engine = makeEngine({ withExisting: true, products: [products[0]] });
  engine.options.environment = "production";
  engine.woo.fetchAllCategories = async () => [
    { id: 5, name: "کیف", slug: "kif", parent: 0, description: "<h2>کیف</h2><p>کیف چرم دست‌دوز</p>" },
  ];

  const report = await engine.runSync({ scope: "content-refresh" });

  const manifestFailure = report.failures.find(
    (f) => f.entity === "categoryEditorial" && f.stage === "manifest",
  );
  assert.ok(manifestFailure, "expected the manifest gate to fail the editorial phase");
  assert.match(String(manifestFailure.error), /CATEGORY_EDITORIAL_EXPECTED_MANIFEST_REQUIRED/);
  // The gate fails the editorial phase only; the rest of the scope still runs,
  // and the non-zero exit comes from hasFailures().
  assert.equal(engine._calls.editorialFinalizes.length, 0);
  assert.ok(engine._calls.upserts.some((c) => c.endpoint === "/products"));
  assert.equal(report.hasFailures(), true);
});

test("content-refresh reaches a product whose sibling variation has stock unmanaged", async () => {
  // The stock-eligibility gate skips this product for any scope that writes
  // stock. A content refresh writes none, so the product's description, gallery
  // and relations must not be collateral damage of a stock setting.
  const engine = makeEngine({ withExisting: true, products: [products[0]] });
  engine.woo.fetchAllVariations = async (productId) =>
    variations
      .filter((variation) => variation.parent_id === productId)
      .map((variation) => (variation.id === 202 ? { ...variation, manage_stock: false } : variation));

  const report = await engine.runSync({ scope: "content-refresh" });

  assert.equal(engine._calls.upserts.filter((c) => c.endpoint === "/products").length, 1);
  assert.equal(report.entities.products.skipped ?? 0, 0);
  assert.equal(engine._calls.stockUpserts.length, 0);
});

test("stock scopes still skip a product whose sibling variation has stock unmanaged", async () => {
  const engine = makeEngine({ withExisting: true, products: [products[0]] });
  engine.woo.fetchAllVariations = async (productId) =>
    variations
      .filter((variation) => variation.parent_id === productId)
      .map((variation) => (variation.id === 202 ? { ...variation, manage_stock: false } : variation));

  const report = await engine.runSync({ scope: "stock" });

  assert.equal(engine._calls.stockUpserts.length, 0);
  assert.equal(report.entities.products.skipped, 1);
});
