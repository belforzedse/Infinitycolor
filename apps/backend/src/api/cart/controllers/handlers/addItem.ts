import { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";

export const addItemHandler = (strapi: Strapi) => async (ctx: any) => {
  const { productVariationId, count } = ctx.request.body;

  try {
    const userId = await resolveCustomerTargetUserId(ctx, strapi);
    if (!userId) return;

    if (!productVariationId) {
      return ctx.badRequest("Product variation ID is required", {
        data: { success: false, error: "Product variation ID is required" },
      });
    }
    if (!count || count < 1) {
      return ctx.badRequest("Count must be a positive number", {
        data: { success: false, error: "Count must be a positive number" },
      });
    }

    const cartService = strapi.service("api::cart.cart");
    const cart = await cartService.getUserCart(userId);
    const result = await cartService.addCartItem(
      cart.id,
      productVariationId,
      count
    );

    if (!result.success) {
      return ctx.badRequest(result.message, {
        data: { success: false, error: result.message },
      });
    }

    return { data: result.data };
  } catch (error: any) {
    return ctx.badRequest(error.message, {
      data: { success: false, error: error.message },
    });
  }
};
