/**
 * Upsert a ProductSlugAlias so a prior slug form permanently resolves
 * to the product's current canonical Slug.
 *
 * Used by the repair script (via HTTP) and by findBySlug's internal
 * fallback. Safe to call repeatedly — unique on Slug.
 */

export async function ensureProductSlugAlias(
  strapi: any,
  slug: string,
  productId: number,
): Promise<void> {
  const normalized = String(slug ?? "");
  if (!normalized || !productId) return;

  const existing = await strapi.entityService.findMany("api::product-slug-alias.product-slug-alias", {
    filters: { Slug: normalized },
    pagination: { limit: 1 },
  });

  const row = (existing as any[])[0];
  if (row) {
    const currentProductId = row.product?.id ?? row.product;
    if (Number(currentProductId) === Number(productId)) return;
    await strapi.entityService.update("api::product-slug-alias.product-slug-alias", row.id, {
      data: { product: productId },
    });
    return;
  }

  await strapi.entityService.create("api::product-slug-alias.product-slug-alias", {
    data: {
      Slug: normalized,
      product: productId,
    },
  });
}
