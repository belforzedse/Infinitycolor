import { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";

export const checkStockHandler = (strapi: Strapi) => async (ctx: any) => {
  try {
    const userId = await resolveCustomerTargetUserId(ctx, strapi);
    if (!userId) return;

    const cartService = strapi.service("api::cart.cart");
    const result = await cartService.checkCartStock(userId);
    return { data: result };
  } catch (error: any) {
    return ctx.badRequest(error.message, {
      data: { success: false, error: error.message },
    });
  }
};
