import type { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";
import { mergeGuestCart } from "../../services/ops/mergeGuestCart";

export const mergeGuestCartHandler = (strapi: Strapi) => async (ctx: any) => {
  const userId = await resolveCustomerTargetUserId(ctx, strapi);
  if (!userId) return;
  const mergeId = String(ctx.request?.body?.mergeId || "").trim();
  try {
    const result = await mergeGuestCart(strapi, userId, mergeId, ctx.request?.body?.items);
    // Strapi's logger prints only the message string, so the counts live in it.
    strapi.log.info(
      `cart.guest_merge: user ${userId} accepted=${result.accepted?.length ?? 0} adjusted=${result.adjusted?.length ?? 0} rejected=${result.rejected?.length ?? 0} replayed=${Boolean(result.replayed)}`,
    );
    return { data: result };
  } catch (error: any) {
    strapi.log.warn(
      `cart.guest_merge_failed: user ${userId}: ${String(error?.message || error).slice(0, 200)}`,
    );
    return ctx.badRequest(error?.message || "Guest cart merge failed", {
      data: { success: false, errorCode: "GUEST_CART_MERGE_INVALID" },
    });
  }
};
