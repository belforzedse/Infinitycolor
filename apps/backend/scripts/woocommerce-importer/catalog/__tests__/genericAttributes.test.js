"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const G = require("../lib/genericAttributes");

function registry() {
  return new Map([
    [1, {
      id: 1,
      name: "Color",
      slug: "color",
      termsByName: new Map([["قرمز", { id: 11, name: "قرمز", slug: "red" }]]),
    }],
    [2, {
      id: 2,
      name: "Size",
      slug: "size",
      termsByName: new Map([["m", { id: 21, name: "M", slug: "m" }]]),
    }],
    [3, {
      id: 3,
      name: "رنگ",
      slug: "رنگ",
      termsByName: new Map([["طلایی", { id: 31, name: "طلایی", slug: "gold" }]]),
    }],
    [4, {
      id: 4,
      name: "Design",
      slug: "design",
      termsByName: new Map([["مینیمال", { id: 41, name: "مینیمال", slug: "minimal" }]]),
    }],
    [5, {
      id: 5,
      name: "کد رنگ",
      slug: "کد-رنگ",
      termsByName: new Map([["a1", { id: 51, name: "A1", slug: "a1" }]]),
    }],
  ]);
}

test("buildProductAttributePlan: preserves five global taxonomies and product-scoped custom duplicates", () => {
  const product = {
    id: 900,
    attributes: [
      { id: 1, name: "Color", variation: true, options: ["قرمز"] },
      { id: 2, name: "Size", variation: true, options: ["M"] },
      { id: 3, name: "رنگ", variation: true, options: ["طلایی"] },
      { id: 4, name: "Design", variation: true, options: ["مینیمال"] },
      { id: 5, name: "کد رنگ", variation: true, options: ["A1"] },
      { id: 0, name: "سایز", variation: true, options: ["خاص"] },
    ],
  };

  const plan = G.buildProductAttributePlan(product, registry());
  assert.equal(plan.dimensions.length, 6);
  assert.deepEqual(
    plan.dimensions.map((dimension) => dimension.legacyProjection),
    ["Color", "Size", "None", "None", "None", "None"],
  );
  assert.equal(plan.dimensions[5].scope, "Product");
  assert.match(plan.dimensions[5].definitionExternalId, /^attribute:product:900:/);
  assert.notEqual(plan.dimensions[1].definitionExternalId, plan.dimensions[5].definitionExternalId);
});

test("selectVariationTerms: maps exact terms and permits an unset optional size", () => {
  const product = {
    id: 901,
    attributes: [
      { id: 1, name: "Color", variation: true, options: ["قرمز"] },
      { id: 4, name: "Design", variation: true, options: ["مینیمال"] },
    ],
  };
  const plan = G.buildProductAttributePlan(product, registry());
  const exact = G.selectVariationTerms({
    attributes: [
      { id: 1, option: "قرمز" },
      { id: 4, option: "مینیمال" },
    ],
  }, plan);
  assert.equal(exact.errors.length, 0);
  assert.equal(exact.selected.length, 2);

  const missingDesign = G.selectVariationTerms({ attributes: [{ id: 1, option: "قرمز" }] }, plan);
  assert.deepEqual(missingDesign.errors.map((error) => error.code), ["MISSING_VARIATION_TERM"]);

  const missingSizePlan = G.buildProductAttributePlan({
    id: 902,
    attributes: [
      { id: 2, name: "Size", variation: true, options: ["M"] },
      { id: 4, name: "Design", variation: true, options: ["مینیمال"] },
    ],
  }, registry());
  const missingSize = G.selectVariationTerms({
    attributes: [{ id: 4, option: "مینیمال" }],
  }, missingSizePlan);
  assert.equal(missingSize.errors.length, 0);
  assert.deepEqual(missingSize.omitted.map((item) => item.code), ["OPTIONAL_SIZE_UNSET"]);
  assert.deepEqual(missingSize.selected.map(({ dimension }) => dimension.legacyProjection), ["None"]);
});
