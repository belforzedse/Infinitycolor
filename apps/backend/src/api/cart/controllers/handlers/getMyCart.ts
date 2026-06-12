import { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";

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
        cart_items: cart.cart_items || [],
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
