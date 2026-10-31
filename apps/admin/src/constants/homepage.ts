/**
 * How many products of a curated homepage section the storefront actually renders.
 *
 * Source of truth is the backend: `HOMEPAGE_CARD_LIMIT` in
 * `apps/backend/src/api/product/services/product.ts`, which `findHomepageSections()`
 * applies to favorites, discounted, custom, weeklyPicks, and everyoneFollows.
 * Newest has its own 100-product rail and does not use this limit.
 *
 * The picker deliberately does not stop you saving more than this; it only marks the
 * overflow, because a hard cap would remove the search box from a section that is
 * already over the limit. For Popular/Discounts specifically, anything past
 * this position is only skipped by the homepage carousel -- it still appears, in this
 * exact order, on that section's full "مشاهده همه" storefront listing (see
 * findProductCards's curated ordering in product-card-query.ts). Other manual
 * sections (custom, weeklyPicks, everyoneFollows) have no such listing page, so past
 * this position they really are never rendered anywhere.
 */
export const HOMEPAGE_RENDER_LIMIT = 20;
