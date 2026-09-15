import { delByPattern } from "./responseCache";
import { triggerFrontendRevalidation } from "./revalidate";

/**
 * Mirrors `productSlugTag` in the storefront
 * (`apps/frontend/src/constants/cacheTags.ts`). The backend cannot import it,
 * so the format is duplicated here and must change in step. The slug is
 * decoded so a percent-encoded caller and a decoded one produce the same tag.
 */
export function productSlugTag(slug: string): string {
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    // A malformed escape means the caller already holds the decoded form.
  }
  return `product:slug:${decoded}`;
}

/**
 * Clear the caches that sit between the database and a rendered storefront page,
 * for one product.
 *
 * Stock lives outside every cached content type, so none of these are purged by
 * a reservation on their own: the Redis endpoint cache holds the by-slug payload
 * for `CACHE_TTL_PRODUCT_BY_SLUG_SEC`, rest-cache holds `view=card` list
 * responses for its own TTL, and Next holds the rendered page under its tags.
 *
 * `availabilityCrossed` decides the blast radius. When a variation crosses in or
 * out of stock the product *cards* change, so listings have to go with it. When
 * only the low-stock number moved, the PDP is the sole surface that changed and
 * invalidating every listing would be pure churn.
 */
export async function clearProductOriginCaches(
  strapi: any,
  slug: string,
  options: { availabilityCrossed: boolean; logPrefix?: string },
): Promise<void> {
  const { availabilityCrossed, logPrefix = "product-origin-cache" } = options;

  // Redis-backed and keyed by a sha1 digest, so the route prefix is the only
  // practical handle. Same call the publication path makes.
  await delByPattern("endpoint-cache:product.");

  if (availabilityCrossed) {
    try {
      const restCache = strapi?.plugin?.("rest-cache");
      const cacheStore = restCache?.service?.("cacheStore");
      await cacheStore?.clearByUid?.("api::product.product", {}, true);
    } catch (error) {
      // In dev the provider is the in-process memory LRU, where this clears only
      // the calling worker. Never fail the purge over it.
      strapi?.log?.warn?.(`[${logPrefix}] rest-cache clear failed`, error);
    }
  }

  try {
    await triggerFrontendRevalidation(
      availabilityCrossed
        ? { type: "product", path: slug }
        : // Tag only, and deliberately without `path`: the route returns on the
          // first `path` branch, and a crossing-scale revalidation here would
          // drop every listing for a number only the PDP shows.
          { tag: productSlugTag(slug) },
      logPrefix,
    );
  } catch (error) {
    strapi?.log?.warn?.(`[${logPrefix}] storefront revalidation failed`, error);
  }
}
