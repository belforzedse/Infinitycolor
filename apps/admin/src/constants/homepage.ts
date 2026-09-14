/**
 * How many products of a curated homepage section the storefront actually renders.
 *
 * Source of truth is the backend: `HOMEPAGE_CARD_LIMIT` in
 * `apps/backend/src/api/product/services/product.ts`, which `findHomepageSections()`
 * applies as `manualIds.slice(0, HOMEPAGE_CARD_LIMIT)` to EVERY manual section —
 * newest, favorites, discounted, custom, weeklyPicks, everyoneFollows.
 *
 * The picker deliberately does not stop you saving more than this; it only marks the
 * overflow, because a hard cap would remove the search box from a section that is
 * already over the limit. Anything past this position is saved and never rendered.
 */
export const HOMEPAGE_RENDER_LIMIT = 20;
