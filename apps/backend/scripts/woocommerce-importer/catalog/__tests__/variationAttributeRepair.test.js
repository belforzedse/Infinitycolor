"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const G = require("../lib/genericAttributes");
const Repair = require("../lib/variationAttributeRepair");
const { parseCliArgs, buildPlan } = require("../../../repair-woocommerce-variation-attributes");

function fixtureProduct() {
  return {
    id: 4557,
    externalId: "1291566",
    slug: "شورت-بهاره-y00761",
    genericAssignments: [{
      id: 5091,
      externalId: "assignment:1291566:global:10",
      attributeId: 31,
      definitionExternalId: "attribute:10",
      terms: [
        { id: 725, externalId: "term:3060" },
        { id: 726, externalId: "term:3056" },
      ],
    }],
    variations: [{
      id: 30173, externalId: "1291570", sku: "WC-1291566-1291570",
      price: "299000", discountPrice: null, isPublished: true,
      productIds: [4557], stocks: [{ id: 77, count: 1, reservedCount: null }],
      selectedTerms: [], attributeSignature: "", colorIds: [], sizeIds: [], modelIds: [],
    }],
  };
}

function sourceFixtures() {
  const product = {
    id: 1291566,
    attributes: [{ id: 10, name: "کد رنگ", visible: false, variation: true, options: ["کد 1", "کد 2"] }],
  };
  const variation = { id: 1291570, attributes: [{ id: 10, name: "کد رنگ", option: "%da%a9%d8%af-1" }] };
  const registry = new Map([[10, {
    id: 10, name: "کد رنگ", slug: "کد-رنگ",
    termsByName: new Map([
      ["کد 1", { id: 3060, name: "کد 1", slug: "%da%a9%d8%af-1" }],
      ["کد 2", { id: 3056, name: "کد 2", slug: "%da%a9%d8%af-2" }],
    ]),
  }]]);
  return { product, variation, registry };
}

test("canonical Woo mapping persists the selected custom term and sorted signature", () => {
  const destination = fixtureProduct();
  const source = sourceFixtures();
  const context = Repair.resolveProductPlan(
    destination, source.product, source.registry,
    { Color: new Map(), Size: new Map(), Model: new Map() },
  );
  assert.deepEqual(Repair.desiredForVariation(source.variation, context), {
    product_variation_color: null,
    product_variation_size: null,
    product_variation_model: null,
    selected_attribute_terms: [725],
    AttributeSignature: "attribute:31=725",
  });
});

test("missing relations are candidates; applying the canonical shape is idempotent", () => {
  const destination = fixtureProduct();
  assert.equal(Repair.classifyProduct(destination).status, "candidate");
  const desired = {
    selected_attribute_terms: [725], AttributeSignature: "attribute:31=725",
    product_variation_color: null, product_variation_size: null, product_variation_model: null,
  };
  assert.equal(Repair.variationNeedsRepair(destination.variations[0], desired), true);
  destination.variations[0].selectedTerms = [{ id: 725, attributeId: 31 }];
  destination.variations[0].attributeSignature = desired.AttributeSignature;
  assert.equal(Repair.variationNeedsRepair(destination.variations[0], desired), false);
  assert.equal(Repair.classifyProduct(destination).status, "healthy");
});

test("duplicate or disallowed mappings fail closed as ambiguous", () => {
  const destination = fixtureProduct();
  destination.variations[0].selectedTerms = [
    { id: 725, attributeId: 31 },
    { id: 999, attributeId: 31 },
  ];
  const result = Repair.classifyProduct(destination);
  assert.equal(result.status, "ambiguous");
  assert.ok(result.reasons.includes("AMBIGUOUS_SELECTED_TERM"));
});

test("repair identity guard covers ids, external ids, SKU, price, stock, reserved stock, and publication", () => {
  const before = fixtureProduct().variations;
  const after = structuredClone(before);
  after[0].selectedTerms = [{ id: 725, attributeId: 31 }];
  after[0].attributeSignature = "attribute:31=725";
  assert.doesNotThrow(() => Repair.assertIdentityUnchanged(before, after));
  after[0].stocks[0].count = 2;
  assert.throws(() => Repair.assertIdentityUnchanged(before, after), /VARIATION_IDENTITY_CHANGED/);
});

test("CLI defaults to dry-run and production apply requires both explicit guards", () => {
  assert.deepEqual(parseCliArgs([]), {
    target: "local", apply: false, verify: false, confirmProduction: "", productExternalIds: [], help: false,
  });
  assert.throws(
    () => parseCliArgs(["--target", "production", "--apply"]),
    /confirm-production infinity-prod/,
  );
  assert.equal(parseCliArgs([
    "--target", "production", "--apply", "--confirm-production", "infinity-prod",
  ]).apply, true);
});

test("source-backed planner repairs exact external identity and then proposes zero changes", async () => {
  const product = fixtureProduct();
  const source = sourceFixtures();
  const classified = Repair.classifyPopulation([product]);
  const engine = {
    woo: {
      fetchProductById: async (id) => { assert.equal(String(id), "1291566"); return source.product; },
      fetchAllVariations: async () => [source.variation],
    },
  };
  const first = await buildPlan({
    classified, legacyMaps: { Color: new Map(), Size: new Map(), Model: new Map() },
    engine, registry: source.registry,
  });
  assert.equal(first.actions.length, 1);
  assert.equal(first.actions[0].variationId, 30173);
  product.variations[0].selectedTerms = [{ id: 725, attributeId: 31 }];
  product.variations[0].attributeSignature = "attribute:31=725";
  const second = await buildPlan({
    classified: Repair.classifyPopulation([product]),
    legacyMaps: { Color: new Map(), Size: new Map(), Model: new Map() },
    engine, registry: source.registry,
  });
  assert.equal(second.actions.length, 0);
});

test("source-backed planner fails closed when a legacy relation is inconsistent", async () => {
  const product = fixtureProduct();
  const source = sourceFixtures();
  source.product.attributes.unshift({
    id: 8, name: "سایز", visible: true, variation: true, options: ["M"],
  });
  source.variation.attributes.unshift({ id: 8, name: "سایز", option: "m" });
  source.registry.set(8, {
    id: 8, name: "سایز", slug: "pa_size",
    termsByName: new Map([["m", { id: 900, name: "M", slug: "m" }]]),
  });
  const plan = await buildPlan({
    classified: Repair.classifyPopulation([product]),
    legacyMaps: { Color: new Map(), Size: new Map([["term:900", [41]]]), Model: new Map() },
    engine: {
      woo: {
        fetchProductById: async () => source.product,
        fetchAllVariations: async () => [source.variation],
      },
    },
    registry: source.registry,
  });

  assert.equal(plan.actions.length, 0);
  assert.match(plan.ambiguous[0].reasons[0], /LEGACY_RELATION_MISMATCH/);
});

test("canonical mapper rejects a source term that the product assignment cannot resolve", () => {
  const destination = fixtureProduct();
  const source = sourceFixtures();
  source.registry.get(10).termsByName.set("کد 3", { id: 9999, name: "کد 3", slug: "کد-3" });
  source.product.attributes[0].options.push("کد 3");
  assert.throws(
    () => Repair.resolveProductPlan(
      destination, source.product, source.registry,
      { Color: new Map(), Size: new Map(), Model: new Map() },
    ),
    /DESTINATION_TERM_MISSING/,
  );
});

test("generic attribute payload sorts mixed canonical signature tokens", () => {
  const plan = {
    sourceProductId: 1,
    dimensions: [
      { sourceKey: "b", isVariation: true, legacyProjection: "None", termsBySourceKey: new Map([["y", { sourceKey: "y" }]]) },
      { sourceKey: "a", isVariation: true, legacyProjection: "None", termsBySourceKey: new Map([["x", { sourceKey: "x" }]]) },
    ],
  };
  const resolved = new Map([
    ["b", { definitionId: 9, resolvedTerms: new Map([["y", { id: 4 }]]) }],
    ["a", { definitionId: 2, resolvedTerms: new Map([["x", { id: 7 }]]) }],
  ]);
  const payload = G.buildVariationAttributePayload(
    { attributes: [{ id: 0, name: "b", option: "y" }, { id: 0, name: "a", option: "x" }] },
    { ...plan, sourceProductId: 1, dimensions: plan.dimensions.map((dimension) => ({
      ...dimension, sourceKey: `product:1:${dimension.sourceKey}`,
    })) },
    new Map([
      ["product:1:b", resolved.get("b")], ["product:1:a", resolved.get("a")],
    ]),
  );
  assert.equal(payload.AttributeSignature, "attribute:2=7|attribute:9=4");
});
