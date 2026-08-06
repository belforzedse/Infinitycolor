"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveSlug, safeDecode } = require("../lib/slug");

test("resolveSlug: uses the exact WooCommerce slug without decoding or normalization", () => {
  assert.equal(resolveSlug({ id: 1, slug: "blue-shirt" }, "product"), "blue-shirt");
  assert.equal(
    resolveSlug({ id: 1, slug: "%da%a9%db%8c%d9%81" }, "product"),
    "%da%a9%db%8c%d9%81",
  );
  assert.equal(resolveSlug({ id: 2, slug: "  exact-source-value  " }, "product"), "  exact-source-value  ");
  assert.equal(resolveSlug({ id: 3, slug: "%E0%A4%A" }, "product"), "%E0%A4%A");
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
