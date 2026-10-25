import type { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";

/** Read-only recovery evidence. A missing row never authorizes a new attempt identity. */
export const checkoutAttemptHandler = (strapi: Strapi) => async (ctx: any) => {
  ctx.set("Cache-Control", "private, no-store");
  const userId = await resolveCustomerTargetUserId(ctx, strapi);
  if (!userId) return;

  const raw = ctx.request.query?.attemptId ?? ctx.query?.attemptId;
  if (typeof raw !== "string" || !raw.trim() || raw.trim().length > 128) {
    return ctx.badRequest("اطلاعات پرداخت معتبر نیست.", {
      data: { success: false, errorCode: "CHECKOUT_ATTEMPT_INVALID" },
    });
  }
  const attemptId = raw.trim();
  try {
    const attempt: any = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
      where: { attemptId, user: { id: userId } },
      select: ["attemptId", "Status", "quoteHash"],
      populate: { order: { select: ["id"] } },
    } as any);
    if (!attempt) return { data: { success: true, lookup: "missing" } };

    const orderId = Number(attempt.order?.id ?? attempt.order);
    return {
      data: {
        success: true,
        lookup: "found",
        attempt: {
          attemptId: attempt.attemptId,
          status: attempt.Status,
          quoteHash: attempt.quoteHash,
          ...(Number.isSafeInteger(orderId) && orderId > 0 ? { orderId } : {}),
        },
      },
    };
  } catch {
    strapi.log.error("Checkout attempt recovery lookup unavailable");
    ctx.status = 503;
    return {
      data: {
        success: false,
        lookup: "unavailable",
        errorCode: "CHECKOUT_ATTEMPT_LOOKUP_UNAVAILABLE",
      },
    };
  }
};
