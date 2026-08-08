/**
 * Canonical Next.js cache tag names for product data.
 *
 * Why tags and not only paths: the storefront uses Persian slugs, and
 * `revalidatePath("/pdp/<persian slug>")` has to match the exact encoding Next
 * stored the route under. Getting that wrong fails silently — the call returns
 * successfully and nothing is invalidated. Tags are opaque strings, so they
 * sidestep encoding entirely.
 *
 * Both the storefront fetches and `app/api/revalidate/route.ts` import from
 * here, so a tag can never be invalidated under a name no fetch attached.
 */

/** Every product-derived response. Coarse; prefer a narrower tag when possible. */
export const PRODUCT_TAG = "product";

/** Product listing/collection data (PLP, category rails, related products). */
export const PRODUCT_COLLECTION_TAG = "product-collection";

/** Homepage product sections. */
export const HOME_PRODUCTS_TAG = "home-products";

/** Sitemap document. */
export const SITEMAP_TAG = "sitemap";

/**
 * A single product identified by its canonical slug.
 *
 * The slug is normalized to its decoded form so that a caller holding the
 * percent-encoded variant and a caller holding the decoded variant produce the
 * same tag. Tag values are never used as URLs, so decoding here is safe.
 */
export function productSlugTag(slug: string): string {
  return `product:slug:${decodeSlugOnce(slug)}`;
}

/** A single product identified by its stable numeric Strapi id. */
export function productIdTag(id: number | string): string {
  return `product:id:${id}`;
}

/** A category page identified by its slug. */
export function categorySlugTag(slug: string): string {
  return `category:slug:${decodeSlugOnce(slug)}`;
}

/**
 * Decode a slug exactly once, tolerating values that are not valid
 * percent-encoding (Persian slugs are stored decoded, but historical rows and
 * inbound URLs may still carry `%d8%b3…` sequences).
 */
export function decodeSlugOnce(slug: string): string {
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}
