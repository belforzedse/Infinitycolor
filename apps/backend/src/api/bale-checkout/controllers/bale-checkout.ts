import type { Context } from "koa";
import { checkoutAttemptOrderId, gateCheckoutResume } from "../../cart/services/lib/checkout-resume";
import { normalizeCheckoutGatewayCode } from "../../payment-gateway/services/checkout-gateway-availability";
import { findPaymentAttempt } from "../../payment-attempt/services/payment-attempt";
import { loadBaleInventory } from "../lib/inventory";
import {
  BaleApiError,
  checkoutNotFound,
  isCheckoutId,
  parseBaleItems,
  parseInventoryLookup,
  requireBotToken,
  requireOpaqueHeader,
  verifyCheckoutGrant,
} from "../lib/protocol";
import { limitBaleRequest } from "../lib/rate-limit";
import {
  baleReturnUrl,
  claimBaleCheckout,
  createBaleCheckout,
  readBaleCheckoutStatus,
  readOwnedBaleCheckout,
  requireActiveBaleCheckout,
  type BaleCheckout,
} from "../services/handoff";

type BaleContext = Context & { request: Context["request"] & { body?: unknown } };

function withBaleResponse(operation: string, handler: (ctx: BaleContext) => Promise<unknown>) {
  return async (ctx: BaleContext) => {
    ctx.set("Cache-Control", "private, no-store");
    ctx.set("Referrer-Policy", "no-referrer");
    try {
      ctx.body = await handler(ctx);
    } catch (error) {
      const known = error instanceof BaleApiError;
      const status = known ? error.status : 500;
      const retryAfter = known ? error.details?.retryAfterSeconds : null;
      if (retryAfter) ctx.set("Retry-After", String(retryAfter));
      if (!known) {
        // Do not log request headers, grants, item payloads, or raw DB bindings.
        strapi.log.error(`Bale checkout ${operation} failed`);
      }
      ctx.status = status;
      ctx.body = {
        data: null,
        error: {
          status,
          name: known ? "BaleApiError" : "InternalServerError",
          message: known ? error.message : "Checkout is temporarily unavailable.",
          details: { ...(known ? error.details : {}), errorCode: known ? error.code : "BALE_INTERNAL_ERROR" },
        },
      };
    }
  };
}

function checkoutIdFrom(ctx: Context): string {
  const checkoutId: unknown = ctx.params.checkoutId;
  if (!isCheckoutId(checkoutId)) throw checkoutNotFound();
  return checkoutId;
}

function userIdFrom(ctx: Context): number {
  const userId = Number(ctx.state.user?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new BaleApiError(401, "BALE_UNAUTHORIZED", "Sign in to open this checkout.");
  }
  return userId;
}

async function ownedSummary(checkout: BaleCheckout) {
  const attempt = checkout.orderId && checkout.userId && checkout.attemptId
    ? await findPaymentAttempt(strapi, checkout.userId, checkout.attemptId)
    : null;
  const gateway = normalizeCheckoutGatewayCode(attempt?.Gateway);
  const resume = gateway && checkout.userId && checkout.attemptId && attempt?.quoteHash &&
    checkoutAttemptOrderId(attempt) === checkout.orderId &&
    ["Created", "Redirected"].includes(attempt.Status) &&
    (await gateCheckoutResume(strapi, checkout.userId, attempt, gateway, attempt.quoteHash)) === "replay"
    ? { gateway, attemptId: checkout.attemptId, quoteHash: attempt.quoteHash }
    : null;
  return {
    checkoutId: checkout.checkoutId,
    orderId: checkout.orderId,
    expiresAt: checkout.expiresAt.toISOString(),
    baleReturnUrl: baleReturnUrl(checkout.checkoutId),
    ...(resume ? { resume } : {}),
  };
}

export default {
  inventory: withBaleResponse("inventory", async (ctx) => {
    requireBotToken(ctx.get("Authorization"));
    await limitBaleRequest("inventory");
    return { items: await loadBaleInventory(strapi, parseInventoryLookup(ctx.query)) };
  }),

  create: withBaleResponse("create", async (ctx) => {
    requireBotToken(ctx.get("Authorization"));
    await limitBaleRequest("create");
    const chatRef = requireOpaqueHeader(ctx.get("X-Bale-Chat-Ref"), "X-Bale-Chat-Ref");
    const idempotencyKey = requireOpaqueHeader(ctx.get("Idempotency-Key"), "Idempotency-Key");
    return createBaleCheckout(strapi, chatRef, idempotencyKey, parseBaleItems(ctx.request.body));
  }),

  status: withBaleResponse("status", async (ctx) => {
    requireBotToken(ctx.get("Authorization"));
    await limitBaleRequest("status");
    const chatRef = requireOpaqueHeader(ctx.get("X-Bale-Chat-Ref"), "X-Bale-Chat-Ref");
    return readBaleCheckoutStatus(strapi, checkoutIdFrom(ctx), chatRef);
  }),

  claim: withBaleResponse("claim", async (ctx) => {
    const userId = userIdFrom(ctx);
    await limitBaleRequest("claim", userId);
    const checkoutId = checkoutIdFrom(ctx);
    verifyCheckoutGrant(checkoutId, ctx.request.body);
    return ownedSummary(await claimBaleCheckout(strapi, checkoutId, userId));
  }),

  read: withBaleResponse("read", async (ctx) => {
    const userId = userIdFrom(ctx);
    await limitBaleRequest("read", userId);
    const checkout = await readOwnedBaleCheckout(strapi, checkoutIdFrom(ctx), userId);
    if (!checkout) throw checkoutNotFound();
    requireActiveBaleCheckout(checkout);
    return ownedSummary(checkout);
  }),
};
