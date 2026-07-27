import type { Strapi } from "@strapi/strapi";

const parseAmount = (value: unknown): number | null => {
  const text = String(value ?? "").trim();
  if (!/^\d{1,18}$/.test(text)) return null;
  const amount = Number(text);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
};

export async function snappayCallbackHandler(strapi: Strapi, ctx: any) {
  const startedAt = Date.now();
  const body = ctx.request?.body || {};
  const query = ctx.request?.query || {};
  const transactionId = String(body.transactionId || "").trim();
  const state = String(body.state || "").trim().toUpperCase();
  const amount = parseAmount(body.amount);
  const nonce = String(query.nonce || "").trim();

  const result = await strapi
    .service("api::payment-gateway.snappay-orchestrator")
    .acceptCallback({
      transactionId,
      state,
      amount: amount || 0,
      nonce,
    });

  // The callback is a browser POST. A 303 guarantees the result page is loaded
  // with GET and prevents form resubmission on refresh.
  ctx.redirect(result.redirectUrl);
  ctx.status = 303;
  const durationMs = Date.now() - startedAt;
  const metrics = (strapi as any).metrics;
  if (typeof metrics?.observe === "function") {
    metrics.observe("snappay_callback_duration_ms", durationMs);
  } else if (typeof metrics?.histogram === "function") {
    metrics
      .histogram("snappay_callback_duration_ms")
      ?.observe?.(durationMs);
  }
}
