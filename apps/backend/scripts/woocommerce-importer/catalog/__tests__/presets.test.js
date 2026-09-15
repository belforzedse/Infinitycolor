"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveScope, resolvePreset, needsProductLoop, writesVariationAttributes, PRESETS, SCOPES,
} = require("../lib/presets");

test("resolveScope: skipStock suppresses stock on every catalog scope", () => {
  for (const scope of ["full", "full-sync", "no-media", "product-no-media", "inventory-instock"]) {
    assert.equal(resolveScope(scope, { skipStock: true }).stock, false, scope);
    assert.equal(resolveScope(scope).stock, true, scope);
  }
  // Everything else the scope covers still runs.
  const full = resolveScope("full", { skipStock: true });
  assert.equal(full.products, true);
  assert.equal(full.variations, true);
  assert.equal(full.media, true);
  assert.equal(full.categories, true);
});

test("resolveScope: skipStock drops the out-of-stock gate", () => {
  assert.equal(resolveScope("inventory-instock").stockGate, "instock-or-verify");
  assert.equal(resolveScope("inventory-instock", { skipStock: true }).stockGate, undefined);
});

test("resolveScope: skipStock on the stock-only scope is rejected", () => {
  assert.throws(() => resolveScope("stock", { skipStock: true }), /writes nothing with skipStock/);
});

test("resolveScope: full enables everything (media unless skipped)", () => {
  assert.deepEqual(resolveScope("full"), {
    categories: true, categoryEditorial: true, products: true, variations: true, stock: true, media: true,
    onlyExisting: false, variationFields: "all",
  });
  assert.equal(resolveScope("full", { skipMedia: true }).media, false);
  // Legacy scopes carry no mediaPolicy → engine treats it as "always".
  assert.equal(resolveScope("full").mediaPolicy, undefined);
});

test("resolveScope: full-sync is a full sync that preserves existing media", () => {
  const f = resolveScope("full-sync");
  assert.equal(f.categories, true);
  assert.equal(f.categoryEditorial, true);
  assert.equal(f.products, true);
  assert.equal(f.variations, true);
  assert.equal(f.stock, true);
  assert.equal(f.media, true);
  assert.equal(f.variationFields, "all");
  assert.equal(f.mediaPolicy, "preserve");
  // --skip-media still wins.
  assert.equal(resolveScope("full-sync", { skipMedia: true }).media, false);
});

test("SCOPES includes full-sync", () => {
  assert.ok(SCOPES.includes("full-sync"));
});

test("resolveScope: no-media never uploads media", () => {
  const f = resolveScope("no-media");
  assert.equal(f.media, false);
  assert.equal(f.products, true);
  assert.equal(f.variations, true);
});

test("resolveScope: product-no-media updates product children without category or media work", () => {
  const f = resolveScope("product-no-media");
  assert.equal(f.categories, false);
  assert.equal(f.products, true);
  assert.equal(f.variations, true);
  assert.equal(f.stock, true);
  assert.equal(f.media, false);
  assert.ok(SCOPES.includes("product-no-media"));
});

test("resolveScope: stock only writes stock, only existing", () => {
  assert.deepEqual(resolveScope("stock"), {
    categories: false, categoryEditorial: false, products: false, variations: false, stock: true, media: false,
    onlyExisting: true, variationFields: "none",
  });
});

test("resolveScope: price writes variations price-only, only existing", () => {
  const f = resolveScope("price");
  assert.equal(f.variations, true);
  assert.equal(f.variationFields, "price-only");
  assert.equal(f.onlyExisting, true);
  assert.equal(f.stock, false);
  assert.equal(f.media, false);
  assert.equal(f.categories, false);
});

test("resolveScope: media only attaches media, only existing", () => {
  const f = resolveScope("media");
  assert.equal(f.media, true);
  assert.equal(f.onlyExisting, true);
  assert.equal(f.products, false);
  assert.equal(f.variations, false);
});

test("resolveScope: categories only", () => {
  const f = resolveScope("categories");
  assert.equal(f.categories, true);
  assert.equal(f.categoryEditorial, true);
  assert.equal(needsProductLoop(f), false);
});

test("resolveScope: category-editorial touches no catalog entities", () => {
  const f = resolveScope("category-editorial");
  assert.equal(f.categoryEditorial, true);
  assert.equal(f.categories, false);
  assert.equal(needsProductLoop(f), false);
  assert.ok(SCOPES.includes("category-editorial"));
});

test("resolveScope: inventory-instock writes stock and price in one pass, gated on stock status", () => {
  assert.deepEqual(resolveScope("inventory-instock"), {
    categories: false, categoryEditorial: false, products: false, variations: true, stock: true, media: false,
    onlyExisting: true, variationFields: "price-only", stockGate: "instock-or-verify",
  });
  assert.ok(SCOPES.includes("inventory-instock"));
  // "all" would make CatalogEngine#resolveProductConcurrency force serial
  // product processing, undoing the parallelism this scope depends on.
  assert.notEqual(resolveScope("inventory-instock").variationFields, "all");
  // The gate is opt-in per scope, never a default.
  assert.equal(resolveScope("stock").stockGate, undefined);
  assert.equal(resolveScope("price").stockGate, undefined);
  assert.equal(resolveScope("full-sync").stockGate, undefined);
});

test("resolveScope: unknown scope throws", () => {
  assert.throws(() => resolveScope("nope"), /Unknown scope/);
});

test("needsProductLoop: true when any product-touching phase is on", () => {
  assert.equal(needsProductLoop(resolveScope("stock")), true);
  assert.equal(needsProductLoop(resolveScope("media")), true);
  assert.equal(needsProductLoop(resolveScope("categories")), false);
});

test("resolvePreset: every preset resolves and is well-formed", () => {
  for (const p of PRESETS) {
    const r = resolvePreset(p.id);
    assert.equal(r.id, p.id);
    assert.equal(typeof r.label, "string");
    if (!r.verify) {
      assert.ok(r.run.scope, `${p.id} must carry a scope`);
      // scope must be resolvable
      resolveScope(r.run.scope);
    }
  }
});

test("resolvePreset: dry-run preset previews full without writing", () => {
  const r = resolvePreset("dry-run");
  assert.equal(r.run.scope, "full");
  assert.equal(r.run.dryRun, true);
  assert.equal(r.confirm, false);
});

test("resolvePreset: verify preset is read-only", () => {
  const r = resolvePreset("verify");
  assert.equal(r.verify, true);
  assert.equal(r.confirm, false);
});

test("resolvePreset: unknown id throws", () => {
  assert.throws(() => resolvePreset("xxx"), /Unknown preset/);
});

test("resolveScope: content-refresh writes content, never price or stock", () => {
  assert.deepEqual(resolveScope("content-refresh"), {
    categories: true, categoryEditorial: true, products: true, variations: true, stock: false, media: true,
    onlyExisting: true, variationFields: "no-price",
  });
  assert.ok(SCOPES.includes("content-refresh"));
});

test("resolveScope: content-refresh drops media with skipMedia and ignores skipStock", () => {
  assert.equal(resolveScope("content-refresh", { skipMedia: true }).media, false);
  // It never writes stock to begin with, so --skip-stock is a harmless no-op
  // rather than the "this run writes nothing" error the stock scope raises.
  assert.equal(resolveScope("content-refresh", { skipStock: true }).stock, false);
});

test("writesVariationAttributes: true for the record-writing modes only", () => {
  assert.equal(writesVariationAttributes(resolveScope("full")), true);
  assert.equal(writesVariationAttributes(resolveScope("content-refresh")), true);
  assert.equal(writesVariationAttributes(resolveScope("price")), false);
  assert.equal(writesVariationAttributes(resolveScope("inventory-instock")), false);
  assert.equal(writesVariationAttributes(resolveScope("stock")), false);
  assert.equal(writesVariationAttributes(resolveScope("media")), false);
});

test("content-refresh needs the product loop", () => {
  assert.equal(needsProductLoop(resolveScope("content-refresh")), true);
});
