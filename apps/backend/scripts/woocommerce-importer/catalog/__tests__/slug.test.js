"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveSlug, safeDecode } = require("../lib/slug");

test("resolveSlug: keeps an already-decoded ASCII slug", () => {
  assert.equal(resolveSlug({ id: 1, slug: "blue-shirt" }, "product"), "blue-shirt");
});

test("resolveSlug: decodes a percent-encoded Persian WooCommerce slug", () => {
  // "%da%a9%db%8c%d9%81" is WooCommerce's encoding of "کیف"
  assert.equal(resolveSlug({ id: 1, slug: "%da%a9%db%8c%d9%81" }, "product"), "کیف");
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

test("resolveSlug: leaves malformed percent-encoding untouched", () => {
  assert.equal(resolveSlug({ id: 3, slug: "%E0%A4%A" }, "product"), "%E0%A4%A");
});

test("resolveSlug: preserves surrounding whitespace from the source (no trim)", () => {
  // Whitespace is unusual but decoding must not invent a different value.
  assert.equal(
    resolveSlug({ id: 2, slug: "  exact-source-value  " }, "product"),
    "  exact-source-value  ",
  );
});

test("resolveSlug: is deterministic (same input → same output)", () => {
  const e = { id: 7, slug: "%da%a9%db%8c%d9%81" };
  assert.equal(resolveSlug(e, "product"), resolveSlug(e, "product"));
  assert.equal(resolveSlug(e, "product"), "کیف");
});

test("resolveSlug: preserves an empty Woo slug without deriving or suffixing it", () => {
  assert.equal(resolveSlug({ id: 7, name: "Red Bag", slug: "" }, "product"), "");
  assert.equal(resolveSlug({ id: 7 }, "product"), "");
});

test("resolveSlug: decoding a double-encoded value once is enough for the common case", () => {
  // If Woo ever handed us an already-decoded value, safeDecode is a no-op for
  // non-encoded text; if it handed us single-encoded, we decode once.
  const once = "%d8%b3%d8%aa-y00574";
  assert.equal(resolveSlug({ id: 9, slug: once }, "product"), safeDecode(once));
  assert.notEqual(resolveSlug({ id: 9, slug: once }, "product"), once);
});

test("safeDecode: never throws on malformed percent-encoding", () => {
  assert.equal(safeDecode("%E0%A4%A"), "%E0%A4%A");
  assert.equal(safeDecode(undefined), "");
});
