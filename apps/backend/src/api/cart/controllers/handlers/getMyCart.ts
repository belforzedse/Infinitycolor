import { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";
import { getAvailableStockCount } from "../../services/lib/stock";

export const getMyCartHandler = (strapi: Strapi) => async (ctx: any) => {
  try {
    const userId = await resolveCustomerTargetUserId(ctx, strapi);
    if (!userId) return;

    const cartService = strapi.service("api::cart.cart");
    const cart = await cartService.getUserCart(userId);

    return {
      data: {
        id: cart.id,
        Status: cart.Status,
        cart_items: (cart.cart_items || []).map((item: any) => ({
          ...item,
          // This is a snapshot for cart controls only. Stock is checked again by
          // the mutation and checkout paths, so stale UI state cannot authorize
          // an unavailable quantity.
          availableStock: item.product_variation?.product_stock
            ? getAvailableStockCount(item.product_variation.product_stock)
            : 0,
        })),
      },
    };
  } catch (error: any) {
    return ctx.badRequest(error.message, {
      data: {
        success: false,
        error: error.message,
      },
    });
  }
};
