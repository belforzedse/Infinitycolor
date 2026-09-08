import type { Context, Next } from "koa";

const MAX_BYTES = 32 * 1024;

export default () => async (ctx: Context, next: Next) => {
  if (ctx.method === "POST" && ctx.path === "/api/issue-reports") {
    const declared = Number(ctx.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      ctx.status = 413;
      ctx.body = {
        error: {
          status: 413,
          name: "PayloadTooLargeError",
          message: "حجم گزارش بیش از حد مجاز است.",
          details: { data: { errorCode: "ISSUE_REPORT_BODY_TOO_LARGE" } },
        },
      };
      return;
    }
  }
  await next();
};
