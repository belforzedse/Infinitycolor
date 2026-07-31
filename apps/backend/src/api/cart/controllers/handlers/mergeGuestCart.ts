import type { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";
import { mergeGuestCart } from "../../services/ops/mergeGuestCart";

export const mergeGuestCartHandler = (strapi: Strapi) => async (ctx: any) => {
  const userId = await resolveCustomerTargetUserId(ctx, strapi);
  if (!userId) return;
  const mergeId = String(ctx.request?.body?.mergeId || "").trim();
  try {
    const result = await mergeGuestCart(strapi, userId, mergeId, ctx.request?.body?.items);
    return { data: result };
  } catch (error: any) {
    return ctx.badRequest(error?.message || "Guest cart merge failed", {
      data: { success: false, errorCode: "GUEST_CART_MERGE_INVALID" },
    });
  }
};
