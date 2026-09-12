import { enqueueEdgeCachePurge } from "../queue/edge-cache";
import { buildProductPaths } from "./edgeCache";

/**
 * Purge the shared caches when a variation crosses in or out of stock.
 *
 * Stock moves on every add-to-cart, every reservation expiry and every
 * checkout, but the PDP only renders *availability* — `ناموجود`, a disabled
 * size, a discount that is hidden when out of stock. The exact number never
 * reaches the HTML; it appears only in a client-side toast that is recomputed
 * from a payload the cart API re-validates server-side. So a stale count cannot
 * oversell, and purging on every decrement would mean a purge per add-to-cart
 * for no visible difference.
 *
 * What does matter is the boolean crossing zero: a product that shows as
 * available but is not, or is available but still shows as sold out. That is
 * what this fires on, in both directions.
 */

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

async function purgeForStock(strapi: any, stockId: number, reason: string): Promise<void> {
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
      paths: buildProductPaths({ slug: product.slug, categorySlugs: product.categorySlugs }),
      reason,
    },
    { dedupeKey: `availability:${product.slug}` },
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

  if (isAvailable(availableBefore) === isAvailable(availableAfter)) return;

  const run = () => {
    void purgeForStock(strapi, stockId, reason).catch((error) => {
      strapi.log?.warn?.(`[availability] Failed to enqueue purge for stock ${stockId}`, error);
    });
  };

  if (trx?.executionPromise && typeof trx.executionPromise.then === "function") {
    void trx.executionPromise.then(run).catch(() => undefined);
    return;
  }

  run();
}
