import type { OrderPaymentStatusResponse } from "@/services/order";
import {
  trackPaymentOutcome,
  trackPurchase,
  type PaymentFailureCategory,
} from "@/lib/analytics";
import { resolvePaymentGateway } from "@/utils/paymentGateways";

/**
 * A paid order older than this does not emit `purchase` when its result page is
 * opened: that is someone reopening a history link (possibly on another device
 * without the once-per-order claim), not a checkout completing now.
 */
export const PURCHASE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

const PAID_ORDER_STATUSES = new Set(["Started", "Shipment", "Done"]);

type StatusSnapshot = Pick<
  OrderPaymentStatusResponse,
  | "orderId"
  | "isPaid"
  | "status"
  | "paymentStatus"
  | "paymentGateway"
  | "attemptId"
  | "paidAmountIrr"
  | "paidAt"
>;

function gatewayKey(result: StatusSnapshot): string | undefined {
  return resolvePaymentGateway(result.paymentGateway)?.key;
}

function isPaid(result: StatusSnapshot): boolean {
  return Boolean(result.isPaid || PAID_ORDER_STATUSES.has(String(result.status || "").trim()));
}

/**
 * Emits the analytics outcome for a payment-status response the backend has
 * just returned. Only the backend's own answer counts: a gateway return, a
 * `resultHint`, or the URL alone never produces a `purchase`.
 *
 * - paid → `purchase` with the settled IRR amount (once per order)
 * - Failed / Expired → `payment_failed` (once per order + attempt)
 * - Cancelled, or a non-paid terminal result the callback marked as cancelled
 *   → `payment_cancelled`
 * - anything else is still in flight and emits nothing here
 */
export function reportPaymentResult(
  result: StatusSnapshot | null | undefined,
  options: { resultHint?: string | null; now?: number } = {},
): void {
  if (!result || !Number.isInteger(Number(result.orderId)) || Number(result.orderId) <= 0) return;
  const gateway = gatewayKey(result);

  if (isPaid(result)) {
    const revenueIrr = Number(result.paidAmountIrr);
    const paidAtMs = result.paidAt ? new Date(result.paidAt).getTime() : NaN;
    const now = options.now ?? Date.now();
    if (!Number.isFinite(revenueIrr) || revenueIrr <= 0) return;
    if (!Number.isFinite(paidAtMs) || now - paidAtMs > PURCHASE_FRESHNESS_MS) return;
    trackPurchase({ orderId: result.orderId, revenueIrr, gateway });
    return;
  }

  const status = result.paymentStatus;
  const cancelledByShopper = options.resultHint === "cancelled";
  if (status === "Cancelled" || (cancelledByShopper && (status === "Failed" || status === "Expired"))) {
    trackPaymentOutcome("payment_cancelled", {
      orderId: result.orderId,
      attemptKey: result.attemptId,
      gateway,
    });
    return;
  }
  if (status === "Failed" || status === "Expired") {
    const failureCategory: PaymentFailureCategory = status === "Expired" ? "expired" : "gateway_failed";
    trackPaymentOutcome("payment_failed", {
      orderId: result.orderId,
      attemptKey: result.attemptId,
      gateway,
      failureCategory,
    });
  }
}

/** The result page stopped polling without a paid or terminal answer. */
export function reportPaymentUnresolved(result: StatusSnapshot | null | undefined): void {
  if (!result || isPaid(result)) return;
  if (!Number.isInteger(Number(result.orderId)) || Number(result.orderId) <= 0) return;
  trackPaymentOutcome("payment_unresolved", {
    orderId: result.orderId,
    attemptKey: result.attemptId,
    gateway: gatewayKey(result),
  });
}
