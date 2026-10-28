const VARIATION_UID = "api::product-variation.product-variation";
const STOCK_UID = "api::product-stock.product-stock";

/**
 * Removes a variation together with the stock row that depends on it. Must run
 * inside `strapi.db.transaction`: the two deletes only make sense together, and
 * reserved inventory refuses the whole removal with a 409.
 *
 * Returns the deleted variation, or null when it no longer exists.
 */
export async function deleteVariationWithStock(strapi: any, variationId: number, trx: any) {
  const variation = await strapi.db.query(VARIATION_UID).findOne({
    where: { id: variationId },
    populate: ["product_stock"],
    transacting: trx,
  });
  if (!variation) return null;

  const stock = variation.product_stock;
  if (stock?.id) {
    const locked = await trx("product_stocks").where({ id: stock.id }).forUpdate().first();
    if (!locked) return null;
    stock.reservedCount = locked.reserved_count;
  }
  if (Number(stock?.reservedCount || 0) > 0) {
    const error: any = new Error("Reserved inventory prevents variation deletion");
    error.status = 409;
    throw error;
  }
  if (stock?.id) {
    await strapi.db.query(STOCK_UID).delete({
      where: { id: stock.id },
      transacting: trx,
    });
  }

  return strapi.db.query(VARIATION_UID).delete({
    where: { id: variationId },
    transacting: trx,
  });
}
