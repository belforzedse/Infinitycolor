import type { Strapi } from "@strapi/strapi";
import { getAvailableStockCount } from "../lib/stock";

export const updateCartItemOp = async (
  strapi: Strapi,
  cartItemId: number,
  count: number
) => {
  const cartItem = await strapi.db.query("api::cart-item.cart-item").findOne({
    where: { id: cartItemId },
    populate: {
      product_variation: {
        populate: { product_stock: true, product: true },
      },
    },
  });

  if (!cartItem) {
    return { success: false, message: "Cart item not found" };
  }

  const variation = cartItem.product_variation;
  const product = variation?.product;
  if (!product || product.removedAt || product.Status !== "Active") {
    return { success: false, message: "Product is not available" };
  }
  if (variation?.IsPublished === false) {
    return { success: false, message: "Product variation is not available" };
  }

  let available = 0;
  try {
    available = variation?.product_stock
      ? getAvailableStockCount(variation.product_stock)
      : 0;
  } catch (error) {
    strapi.log.error("Failed to get available stock count", {
      cartItemId,
      error: (error as Error).message,
    });
    return { success: false, message: "Unable to verify stock" };
  }

  if (!variation?.product_stock || available < count) {
    return { success: false, message: "Insufficient stock" };
  }

  const price = variation.Price || 0;
  const updatedItem = await strapi.entityService.update(
    "api::cart-item.cart-item",
    cartItemId,
    {
      data: { Count: count, Sum: count * price },
    }
  );

  return { success: true, data: updatedItem };
};
