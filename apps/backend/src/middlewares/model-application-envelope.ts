import type { Context, Next } from "koa";

const MAX_BYTES = 12 * 1024 * 1024;

export default () => async (ctx: Context, next: Next) => {
  if (ctx.method === "POST" && ctx.path === "/api/model-applications") {
    const declared = Number(ctx.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      ctx.status = 413;
      ctx.body = {
        error: {
          status: 413,
          name: "PayloadTooLargeError",
          message: "حجم درخواست بیش از حد مجاز است.",
          details: { data: { errorCode: "MODEL_APPLICATION_BODY_TOO_LARGE" } },
        },
      };
      return;
    }
  }
  await next();
};
