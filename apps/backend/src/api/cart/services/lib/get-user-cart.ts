import type { Strapi } from "@strapi/strapi";
import { resolveUserCartId } from "./user-cart-identity";

export const getOrCreateUserCart = async (strapi: Strapi, userId: number) => {
  // Resolved by id: a `{ user }` filter is LIMIT 1 with no ORDER BY, and creating
  // through Strapi's oneToOne relation can unlink the cart a concurrent merge filled.
  const cartId = await resolveUserCartId(strapi, userId);
  const cart = await strapi.db.query("api::cart.cart").findOne({
    where: { id: cartId },
    populate: {
      cart_items: {
        populate: {
          product_variation: {
            populate: {
              product_stock: true,
              product_variation_color: true,
              product_variation_size: true,
              product_variation_model: true,
              product: {
                fields: ["id", "Title", "SKU", "Weight", "Status", "removedAt"],
                populate: {
                  CoverImage: true,
                  product_main_category: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!cart) {
    throw new Error(`Cart ${cartId} resolved for user ${userId} could not be loaded`);
  }

  // Clean up cart items with missing product data to prevent checkout errors
  if (cart.cart_items && cart.cart_items.length > 0) {
    const validItems = cart.cart_items.filter((item: any) => {
      const hasValidVariation = item.product_variation && item.product_variation.id;
      const hasValidProduct = item.product_variation?.product && item.product_variation.product.id;
      const product = item.product_variation?.product;
      const variation = item.product_variation;

      if (!hasValidVariation || !hasValidProduct) {
        strapi.log.warn(`Filtering out invalid cart item ${item.id}: missing product_variation or product`);
        return false;
      }

      // Check if product is soft-deleted or inactive
      const isProductAvailable = !product?.removedAt && product?.Status === "Active";
      if (!isProductAvailable) {
        strapi.log.warn(`Filtering out cart item ${item.id}: product is soft-deleted or inactive`, {
          productId: product?.id,
          removedAt: product?.removedAt,
          status: product?.Status,
        });
        return false;
      }

      // Check if variation is unpublished
      const isVariationPublished = variation?.IsPublished !== false;
      if (!isVariationPublished) {
        strapi.log.warn(`Filtering out cart item ${item.id}: variation is unpublished`, {
          variationId: variation?.id,
        });
        return false;
      }

      return true;
    });

    cart.cart_items = validItems;
  }

  return cart;
};
