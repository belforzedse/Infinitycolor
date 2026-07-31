import { RateLimit } from "koa2-ratelimit";
import type { Strapi } from "@strapi/strapi";

export default (_config: unknown, { strapi }: { strapi: Strapi }) => {
  const limiter = RateLimit.middleware({
    skipFailedRequests: true,
    interval: { min: 1 },
    max: 10,
  });

  return async (ctx: any, next: any) => {
    try {
      return await limiter(ctx, next);
    } catch (error: any) {
      if (error?.status !== 429) throw error;
      strapi.log.warn("Payment reconciliation rate limit exceeded", {
        userId: ctx.state?.user?.id,
        orderId: ctx.params?.id,
        ip: ctx.request?.ip,
      });
      ctx.status = 429;
      ctx.body = {
        statusCode: 429,
        error: "Too Many Requests",
        message: "Please wait before checking the payment again.",
      };
      return ctx;
    }
  };
};
