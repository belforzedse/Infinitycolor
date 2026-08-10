"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveSlug, safeDecode } = require("../lib/slug");

test("resolveSlug: keeps decoded ASCII and decodes Persian transport encoding", () => {
  assert.equal(resolveSlug({ id: 1, slug: "blue-shirt" }, "product"), "blue-shirt");
  assert.equal(resolveSlug({ id: 1, slug: "%da%a9%db%8c%d9%81" }, "product"), "کیف");
  assert.equal(
    resolveSlug({ id: 2, slug: "  exact-source-value  " }, "product"),
    "  exact-source-value  ",
  );
  assert.equal(resolveSlug({ id: 3, slug: "%E0%A4%A" }, "product"), "%E0%A4%A");
});

test("resolveSlug: decodes the Adelina W00238 production regression", () => {
  assert.equal(
    resolveSlug(
      {
        id: 2487,
        slug: "%da%a9%d8%aa-%d8%a2%d8%af%d9%84%db%8c%d9%86%d8%a7-w00238",
      },
      "product",
    ),
    "کت-آدلینا-w00238",
  );
});

test("resolveSlug: is deterministic (same input → same output, no Date.now)", () => {
  const e = { id: 7, slug: "x-y" };
  assert.equal(resolveSlug(e, "product"), resolveSlug(e, "product"));
});

test("resolveSlug: preserves an empty Woo slug without deriving or suffixing it", () => {
  assert.equal(resolveSlug({ id: 7, name: "Red Bag", slug: "" }, "product"), "");
  assert.equal(resolveSlug({ id: 7 }, "product"), "");
});

test("safeDecode: never throws on malformed percent-encoding", () => {
  assert.equal(safeDecode("%E0%A4%A"), "%E0%A4%A");
  assert.equal(safeDecode(undefined), "");
});
