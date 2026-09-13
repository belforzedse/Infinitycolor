"use strict";

/**
 * One classification of a WooCommerce order line's catalog reference, shared by
 * the order transform, the variation-preparation pass and the pilot gate so the
 * three can never disagree about which lines carry a live catalog reference.
 *
 * A line whose `product_id` and `variation_id` are both missing/zero is a
 * historical purchase whose product was deleted or archived in WooCommerce
 * after the sale. Those lines are still real sales: they keep their line id,
 * title, quantity and money, but they must never be matched to a catalog item
 * by guesswork.
 */

const ORPHAN = "orphan";
const CATALOG = "catalog";

function positiveIdString(value) {
  const id = String(value ?? "").trim();
  return /^\d+$/.test(id) && id !== "0" ? id : null;
}

/**
 * @param {object} line WooCommerce line item
 * @returns {{ kind: "catalog", productSourceId: string|null, variationSourceId: string }
 *   | { kind: "orphan", productSourceId: null, variationSourceId: null }}
 */
function classifyOrderLine(line) {
  const productSourceId = positiveIdString(line?.product_id);
  const variationId = positiveIdString(line?.variation_id);
  if (!productSourceId && !variationId) {
    return { kind: ORPHAN, productSourceId: null, variationSourceId: null };
  }
  return {
    kind: CATALOG,
    productSourceId,
    // Simple products carry their own id as the sellable unit.
    variationSourceId: variationId || productSourceId,
  };
}

function isOrphanOrderLine(line) {
  return classifyOrderLine(line).kind === ORPHAN;
}

/** Deterministic non-catalog SKU for an orphan line without a source SKU. */
function orphanLineSku(lineId) {
  return `WC-LINE-${String(lineId)}`;
}

module.exports = {
  ORDER_LINE_ORPHAN: ORPHAN,
  ORDER_LINE_CATALOG: CATALOG,
  classifyOrderLine,
  isOrphanOrderLine,
  orphanLineSku,
};
