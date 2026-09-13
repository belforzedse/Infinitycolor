"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../lib/transforms");
const { classifyOrderLine, isOrphanOrderLine, orphanLineSku } = require("../lib/orderLines");

/**
 * WooCommerce keeps the line rows of a sale after the product behind them is
 * deleted; those rows carry `product_id = 0, variation_id = 0`. The importer
 * used to reject the whole order for one such line, which lost 588 real
 * historical sales. These tests pin the replacement rule: the line is kept as a
 * snapshot with no catalog relation, and nothing is ever guessed.
 */

const baseOrder = {
  id: 1269185,
  customer_id: 0,
  date_created_gmt: "2026-01-02T03:04:05",
  status: "completed",
  total: "1000",
  shipping_total: "0",
  total_tax: "0",
  payment_method: "cod",
  billing: { phone: "09123456789" },
};

test("classifyOrderLine only calls a line orphan when it has no reference at all", () => {
  assert.deepEqual(classifyOrderLine({ product_id: 0, variation_id: 0 }), {
    kind: "orphan",
    productSourceId: null,
    variationSourceId: null,
  });
  assert.deepEqual(classifyOrderLine({ product_id: "0", variation_id: "" }), {
    kind: "orphan",
    productSourceId: null,
    variationSourceId: null,
  });
  // A simple product sells through its own id — that is a catalog line whose
  // variation reference is the product itself, not an orphan.
  assert.deepEqual(classifyOrderLine({ product_id: 3, variation_id: 0 }), {
    kind: "catalog",
    productSourceId: "3",
    variationSourceId: "3",
  });
  assert.deepEqual(classifyOrderLine({ product_id: 3, variation_id: 4 }), {
    kind: "catalog",
    productSourceId: "3",
    variationSourceId: "4",
  });
  // A variation without its parent is still a catalog reference: unresolved is
  // a lookup outcome, not a licence to drop the relation.
  assert.equal(classifyOrderLine({ product_id: 0, variation_id: 4 }).kind, "catalog");
  assert.equal(isOrphanOrderLine({ product_id: 0, variation_id: 0 }), true);
  assert.equal(isOrphanOrderLine({ product_id: 12, variation_id: 0 }), false);
});

test("a negative or non-numeric reference is never read as a catalog id", () => {
  for (const line of [{ product_id: -1, variation_id: -1 }, { product_id: "abc", variation_id: null }]) {
    assert.equal(classifyOrderLine(line).kind, "orphan");
  }
});

test("orderPayload imports an order mixing catalog and orphan lines", () => {
  const payload = T.orderPayload({
    ...baseOrder,
    total: "3000",
    line_items: [
      { id: 9, product_id: 3, variation_id: 4, quantity: 1, total: "1000", name: "کالای موجود", sku: "IN-STOCK" },
      { id: 10, product_id: 0, variation_id: 0, quantity: 2, total: "2000", name: "کالای حذف‌شده" },
    ],
  });
  assert.equal(payload.items.length, 2);
  assert.equal(payload.orphanLineCount, 1);
  assert.deepEqual(payload.items[0], {
    sourceId: "9",
    catalogReference: "catalog",
    variationSourceId: "4",
    count: 1,
    unitPriceToman: "1000",
    title: "کالای موجود",
    sku: "IN-STOCK",
  });
  assert.deepEqual(payload.items[1], {
    sourceId: "10",
    catalogReference: "orphan",
    variationSourceId: null,
    count: 2,
    unitPriceToman: "1000",
    title: "کالای حذف‌شده",
    sku: "WC-LINE-10",
  });
  // The sale's money is untouched by the classification.
  assert.equal(payload.totalToman, "3000");
});

test("an order whose every line is orphaned still imports with its exact money", () => {
  const payload = T.orderPayload({
    ...baseOrder,
    total: "450000",
    line_items: [
      { id: 1, product_id: 0, variation_id: 0, quantity: 1, total: "450000", name: "کالا" },
    ],
  });
  assert.equal(payload.orphanLineCount, 1);
  assert.equal(payload.items[0].variationSourceId, null);
  assert.equal(payload.totalToman, "450000");
  assert.equal(payload.items[0].unitPriceToman, "450000");
});

test("the WC-LINE fallback is reserved for orphans and never overwrites a real SKU", () => {
  const payload = T.orderPayload({
    ...baseOrder,
    total: "2000",
    line_items: [
      { id: 7, product_id: 0, variation_id: 0, quantity: 1, total: "1000", name: "a", sku: "REAL-SKU" },
      { id: 8, product_id: 5, variation_id: 6, quantity: 1, total: "1000", name: "b" },
    ],
  });
  assert.equal(payload.items[0].sku, "REAL-SKU", "a recorded SKU survives");
  assert.equal(payload.items[1].sku, "WC-6", "catalog lines keep the variation fallback");
  assert.equal(orphanLineSku(7), "WC-LINE-7");
});

test("line-level validation still fails closed for everything except the missing reference", () => {
  const withLine = (line) => () => T.orderPayload({ ...baseOrder, line_items: [line] });
  assert.throws(withLine({ id: 0, product_id: 0, variation_id: 0, quantity: 1, total: "1000" }), /ORDER_ITEM_SOURCE_ID_INVALID/);
  assert.throws(withLine({ id: 5, product_id: 0, variation_id: 0, quantity: 0, total: "1000" }), /ORDER_ITEM_COUNT_INVALID/);
  assert.throws(withLine({ id: 5, product_id: 0, variation_id: 0, quantity: 1, total: "-1000" }), /ORDER_ITEM_PRICE_INVALID/);
  assert.throws(withLine({ id: 5, product_id: 0, variation_id: 0, quantity: 1, total: "10.5" }), /ORDER_ITEM_PRICE_INVALID/);
});

test("an emptied zero-total order is excluded terminally, not failed", () => {
  let thrown = null;
  try {
    T.orderPayload({ ...baseOrder, id: 1273484, total: "0", line_items: [] });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "an excluded order still stops the import of that order");
  assert.equal(thrown.code, "ORDER_EMPTY_ZERO_TOTAL_EXCLUDED");
  assert.equal(thrown.outcome, "excluded", "the caller records a terminal decision, not a retry");
});

test("an empty order that still carries money fails under its own code", () => {
  assert.throws(
    () => T.orderPayload({ ...baseOrder, total: "250000", line_items: [] }),
    /ORDER_ITEMS_EMPTY_NONZERO_TOTAL/,
  );
});

test("an ordinary order is unchanged apart from the new reference marker", () => {
  const payload = T.orderPayload({
    ...baseOrder,
    line_items: [{ id: 9, product_id: 3, variation_id: 4, quantity: 2, total: "1000", price: "500", name: "کالا", sku: "S" }],
  });
  assert.equal(payload.orphanLineCount, 0);
  assert.equal(payload.items[0].catalogReference, "catalog");
  assert.equal(payload.items[0].variationSourceId, "4");
  assert.equal(payload.items[0].unitPriceToman, "500");
  assert.equal(payload.status, "Done");
});
