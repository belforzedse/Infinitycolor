import { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";

export const checkStockHandler = (strapi: Strapi) => async (ctx: any) => {
  try {
    const userId = await resolveCustomerTargetUserId(ctx, strapi);
    if (!userId) return;

    const rawAttemptId = ctx.request.query?.attemptId ?? ctx.request.body?.attemptId;
    const attemptId = String(rawAttemptId || "").trim();

    const cartService = strapi.service("api::cart.cart");
    const result = attemptId
      ? await cartService.checkCartStock(userId, { attemptId })
      : await cartService.checkCartStock(userId);
    if (result?.errorCode === "RESERVATION_LOOKUP_FAILED") {
      ctx.status = 503;
    }
    return { data: result };
  } catch (error: any) {
    return ctx.badRequest(error.message, {
      data: { success: false, error: error.message },
    });
  }
};
