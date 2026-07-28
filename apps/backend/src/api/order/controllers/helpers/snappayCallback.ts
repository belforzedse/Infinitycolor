import type { Strapi } from "@strapi/strapi";
import { paymentResultUrl } from "../../../payment-gateway/services/snappay-orchestrator";

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

  const orchestrator = strapi.service("api::payment-gateway.snappay-orchestrator");

  let result: { redirectUrl: string };
  try {
    result = await orchestrator.acceptCallback({
      transactionId,
      state,
      amount: amount || 0,
      nonce,
    });
  } catch (error: any) {
    // Two callbacks for the same transaction race to create the reconciliation
    // operation and the loser hits the unique constraint on `idempotencyKey`. The
    // winner has already queued the work, so the payment still settles — but this
    // used to escape as a 500, showing the customer a failure and looking like a
    // hard error in logs. Send them to the normal processing page instead.
    const isDuplicate =
      String(error?.code) === "23505" ||
      /duplicate key|unique constraint/i.test(String(error?.message || ""));
    strapi.log[isDuplicate ? "warn" : "error"](
      isDuplicate
        ? "Concurrent SnappPay callback lost the operation race; already queued"
        : "SnappPay callback could not be accepted",
      {
        transactionId,
        state,
        error: String(error?.message || error).slice(0, 300),
      },
    );
    result = {
      redirectUrl: paymentResultUrl(
        undefined,
        isDuplicate ? "processing" : "invalid_callback",
      ),
    };
  }

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
