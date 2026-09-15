import { enqueueEdgeCachePurge } from "../queue/edge-cache";
import { buildProductPaths } from "./edgeCache";
import { LOW_STOCK_DISPLAY_THRESHOLD } from "../api/cart/services/lib/stock";

/**
 * Purge the shared caches when a stock move changes something a shopper sees.
 *
 * This used to fire only on the availability boolean crossing zero, reasoning
 * that "the exact number never reaches the HTML". It does now: at or below
 * `LOW_STOCK_DISPLAY_THRESHOLD` the PDP prints «تنها N عدد باقی مانده» and the
 * quantity selector offers exactly N options, so a stale count is a visible
 * lie. Nor does stock move on every add-to-cart — `reserveStockAtomic` has one
 * call site, inside `finalizeCartToOrder` — so reservations move per checkout
 * attempt, not per click, and purging on the displayed value is cheap.
 *
 * Everything above the threshold collapses into one bucket, so a 40 → 39 move
 * is silent while 6 → 5 (which newly renders a number) is not.
 */

function displayedAvailability(value: number): number {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return Math.min(safe, LOW_STOCK_DISPLAY_THRESHOLD + 1);
}

function isAvailable(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

async function resolveProductForStock(
  strapi: any,
  stockId: number,
): Promise<{ slug: string; categorySlugs: string[] } | null> {
  const variation = await strapi.db.query("api::product-variation.product-variation").findOne({
    where: { product_stock: { id: stockId } },
    populate: {
      product: {
        populate: {
          product_main_category: true,
          product_other_categories: true,
        },
      },
    },
  });

  const product = variation?.product;
  const slug = String(product?.Slug || "").trim();
  if (!slug) return null;

  const categories = [
    product?.product_main_category,
    ...(Array.isArray(product?.product_other_categories) ? product.product_other_categories : []),
  ];

  const categorySlugs = categories
    .map((category: any) => String(category?.Slug || "").trim())
    .filter(Boolean);

  return { slug, categorySlugs };
}

async function purgeForStock(
  strapi: any,
  stockId: number,
  reason: string,
  availabilityCrossed: boolean,
): Promise<void> {
  const product = await resolveProductForStock(strapi, stockId);
  if (!product) {
    strapi.log?.warn?.(
      `[availability] Stock ${stockId} crossed an availability boundary but no product slug was found`,
    );
    return;
  }

  await enqueueEdgeCachePurge(
    {
      kind: "availability",
      paths: availabilityCrossed
        ? buildProductPaths({ slug: product.slug, categorySlugs: product.categorySlugs })
        : [`/pdp/${product.slug}`],
      reason,
      origin: { productSlug: product.slug, availabilityCrossed },
    },
    // Scoped by what changed. A shared key would let a low-stock purge and a
    // sold-out purge collide inside one dedupe bucket, and the narrower job
    // would win — leaving every listing stale.
    {
      dedupeKey: `availability:${product.slug}:${availabilityCrossed ? "crossing" : "count"}`,
    },
  );
}

/**
 * Fire-and-forget, and only after the transaction that moved the stock has
 * actually committed — mirroring `scheduleHomeProductsRevalidation`. Purging
 * inside the transaction would re-render the PDP from a snapshot that may still
 * be rolled back, writing the pre-transaction state straight back into the cache.
 */
export function scheduleAvailabilityTransitionPurge(
  strapi: any,
  params: {
    stockId: number;
    availableBefore: number;
    availableAfter: number;
    reason: string;
    trx?: any;
  },
): void {
  const { stockId, availableBefore, availableAfter, reason, trx } = params;

  if (displayedAvailability(availableBefore) === displayedAvailability(availableAfter)) return;

  // Cards only change when the boolean flips; below the threshold it is just
  // the PDP's number moving, and the listings can be left alone.
  const availabilityCrossed = isAvailable(availableBefore) !== isAvailable(availableAfter);

  const run = () => {
    void purgeForStock(strapi, stockId, reason, availabilityCrossed).catch((error) => {
      strapi.log?.warn?.(`[availability] Failed to enqueue purge for stock ${stockId}`, error);
    });
  };

  if (trx?.executionPromise && typeof trx.executionPromise.then === "function") {
    void trx.executionPromise.then(run).catch(() => undefined);
    return;
  }

  run();
}
