"use strict";

/**
 * Narrow repair path for Woo order lines whose sellable units were skipped by
 * the catalog unmanaged-stock gate. Upserts the referenced variation (or
 * synthetic simple) with managed stock count 0 when Woo does not manage stock.
 * Does NOT relax the nightly catalog eligibility gate.
 */

const CatalogT = require("../woocommerce-importer/catalog/lib/transforms");
const CatalogG = require("../woocommerce-importer/catalog/lib/genericAttributes");
const { classifyOrderLine, ORDER_LINE_ORPHAN } = require("../woocommerce-importer/migration-v2/lib/orderLines");

/**
 * Catalog references worth preparing. Orphan lines (no product and no
 * variation reference — a product deleted after the sale) are skipped
 * explicitly: there is no product 0 to fetch and no parent to report missing.
 * `lineRefs(order).orphanLineIds` lists what was skipped so the caller can
 * count it without re-classifying.
 */
function lineRefs(order) {
  const lines = Array.isArray(order?.line_items) ? order.line_items : [];
  const refs = [];
  const orphanLineIds = [];
  for (const line of lines) {
    const reference = classifyOrderLine(line);
    const lineId = String(line.id || "");
    if (reference.kind === ORDER_LINE_ORPHAN) {
      orphanLineIds.push(lineId);
      continue;
    }
    if (!reference.productSourceId) continue; // variation without a parent id: nothing to prepare
    refs.push({
      productSourceId: reference.productSourceId,
      variationSourceId: reference.variationSourceId,
      lineId,
    });
  }
  Object.defineProperty(refs, "orphanLineIds", { value: orphanLineIds, enumerable: false });
  return refs;
}

/**
 * @param {object} args
 * @param {import('../woocommerce-importer/migration-v2/lib/source').WordPressSource} args.source
 * @param {import('../woocommerce-importer/catalog/lib/strapiRepo')} args.repo
 * @param {import('../woocommerce-importer/catalog/engine').CatalogEngine} [args.catalogEngine]
 * @param {object} args.order Woo order payload (needs line_items)
 * @param {{ warn?: Function, info?: Function, debug?: Function }} [args.logger]
 * @param {Map<string, { id:number }>} [args.variationIndex] Optional external_id -> row
 *   snapshot (repo.buildExternalIndex("/product-variations")). Without it the
 *   campaign pays one Strapi GET per distinct line item — ~150k round-trips
 *   across a full order run. A miss still falls back to findByExternalId,
 *   because the index is a snapshot and another worker may have created the
 *   row since; anything this function creates is written back into it.
 * @returns {Promise<{ ensured: string[], present: string[], failed: Array<{ variationSourceId: string, error: string }>, orphanSkipped: string[] }>}
 */
async function ensureOrderReferencedVariations({
  source,
  repo,
  catalogEngine = null,
  order,
  logger = console,
  variationIndex = null,
}) {
  const ensured = [];
  const present = [];
  const failed = [];
  const seen = new Set();
  const refs = lineRefs(order);
  const orphanSkipped = refs.orphanLineIds || [];

  for (const ref of refs) {
    if (seen.has(ref.variationSourceId)) continue;
    seen.add(ref.variationSourceId);
    try {
      const indexed = variationIndex ? variationIndex.get(ref.variationSourceId) : null;
      const existing = indexed?.id
        ? indexed
        : await repo.findByExternalId("/product-variations", ref.variationSourceId);
      if (existing?.id) {
        present.push(ref.variationSourceId);
        continue;
      }

      const parent = await repo.findByExternalId("/products", ref.productSourceId);
      if (!parent?.id) {
        failed.push({
          variationSourceId: ref.variationSourceId,
          error: `ORDER_VARIATION_PARENT_MISSING:${ref.productSourceId}`,
        });
        continue;
      }

      const wcProduct = await source.getProduct(ref.productSourceId);
      const isSimple = ref.productSourceId === ref.variationSourceId;
      let wcVariation;
      if (isSimple) {
        wcVariation = CatalogT.synthesizeSimpleVariation(wcProduct);
      } else {
        const response = await source.woo.get(
          `/products/${ref.productSourceId}/variations/${ref.variationSourceId}`,
        );
        wcVariation = response.data;
      }
      if (!wcVariation?.id) {
        failed.push({
          variationSourceId: ref.variationSourceId,
          error: "ORDER_VARIATION_SOURCE_MISSING",
        });
        continue;
      }

      const { data, priceMissing, sourceTimestamps } = CatalogT.mapVariation(wcVariation, {
        parentStrapiId: Number(parent.id),
        parentProduct: wcProduct,
        preserveMissingPrice: false,
      });
      if (priceMissing && (data.Price === undefined || data.Price === null)) {
        data.Price = 0;
      }

      const hasVariationAttributes = (Array.isArray(wcProduct?.attributes)
        && wcProduct.attributes.some((attribute) => attribute?.variation === true))
        || (Array.isArray(wcVariation?.attributes) && wcVariation.attributes.length > 0);
      if (!catalogEngine && hasVariationAttributes) {
        const error = new Error("ORDER_VARIATION_ATTRIBUTE_CONTEXT_REQUIRED");
        error.code = "ORDER_VARIATION_ATTRIBUTE_CONTEXT_REQUIRED";
        throw error;
      }
      const attributeContext = catalogEngine
        ? await catalogEngine.prepareProductAttributeContext(wcProduct, Number(parent.id))
        : { plan: { sourceProductId: Number(wcProduct.id), dimensions: [] }, resolvedDimensions: new Map() };
      Object.assign(
        data,
        CatalogG.buildVariationAttributePayload(
          wcVariation,
          attributeContext.plan,
          attributeContext.resolvedDimensions,
        ),
      );

      // Passing the shared index (when we have one) makes repo.upsert write the
      // new row straight back into it, so a later order referencing the same
      // variation is a Map hit rather than another POST + 409 recovery.
      const { id: variationStrapiId, mode } = await repo.upsert({
        endpoint: "/product-variations",
        externalId: ref.variationSourceId,
        payload: data,
        index: variationIndex || new Map(),
        sourceTimestamps,
      });
      const relationCheck = catalogEngine
        ? await catalogEngine.verifyVariationAttributeRelations(variationStrapiId, data)
        : { ok: true };
      if (!relationCheck.ok) {
        const error = new Error(`ORDER_VARIATION_ATTRIBUTE_PERSISTENCE_FAILED:${relationCheck.error}`);
        error.code = "ORDER_VARIATION_ATTRIBUTE_PERSISTENCE_FAILED";
        throw error;
      }

      const managed = wcVariation.manage_stock === true;
      const qty = Number(wcVariation.stock_quantity);
      const count = managed && Number.isFinite(qty) ? Math.max(0, qty) : 0;
      await repo.upsertStock({
        externalId: `stock_${ref.variationSourceId}`,
        count,
        variationId: variationStrapiId,
        stockIndex: new Map(),
        sourceTimestamps,
      });

      ensured.push(ref.variationSourceId);
      logger.info?.("[WooSync] ensured order-referenced variation", {
        variationSourceId: ref.variationSourceId,
        productSourceId: ref.productSourceId,
        mode,
        stockCount: count,
        forcedUnmanagedStock: !managed,
      });
    } catch (error) {
      const message = String(error?.payload?.error || error?.message || error);
      failed.push({ variationSourceId: ref.variationSourceId, error: message.slice(0, 200) });
      logger.warn?.("[WooSync] failed ensuring order-referenced variation", {
        variationSourceId: ref.variationSourceId,
        error: message.slice(0, 200),
      });
    }
  }

  return { ensured, present, failed, orphanSkipped };
}

module.exports = {
  ensureOrderReferencedVariations,
  lineRefs,
};
