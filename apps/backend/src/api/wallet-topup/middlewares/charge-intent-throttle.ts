import { RateLimit } from "koa2-ratelimit";
import type { Strapi } from "@strapi/strapi";

/**
 * `charge-intent-throttle`
 *
 * Opening a payment session costs the store a provider call and leaves a
 * durable row behind, so the rate at which one customer may do it is capped.
 *
 * This is a cost control, not a correctness one: exactly-once creation comes
 * from the owner-scoped idempotency key and the advisory-locked pending cap in
 * `createWalletTopupIntent`. Throttling is never applied to provider callbacks —
 * a bank cannot be asked to back off, and a dropped callback is a lost payment.
 */
export default (config, { strapi }: { strapi: Strapi }) => {
  const limiter = RateLimit.middleware({
    skipFailedRequests: true,
    interval: { min: 1 },
    max: 5,
    keyGenerator: async (ctx: any) =>
      `wallet-topup:${ctx.state?.user?.id || "anonymous"}:${ctx.request.ip}`,
  });

  return async (ctx, next) => {
    try {
      return await limiter(ctx, next);
    } catch (err: any) {
      if (err.status === 429) {
        strapi.log.warn(
          `Wallet top-up rate limit exceeded for user ${ctx.state?.user?.id || "anonymous"}`,
        );
        ctx.status = 429;
        ctx.body = {
          statusCode: 429,
          error: "Too Many Requests",
          message: "درخواست‌های زیادی ثبت شده است. لطفاً یک دقیقه بعد دوباره تلاش کنید.",
        };
        return ctx;
      }
      throw err;
    }
  };
};
