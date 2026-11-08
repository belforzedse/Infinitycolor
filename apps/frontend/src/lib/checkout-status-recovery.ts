import { persistCheckoutOrder, readCheckoutIdentity } from "./checkout-identity";

/**
 * Checkout codes that mean "do not start a second payment". The payment-result
 * page already polls status and kicks SnappPay reconcile; checkout should open
 * that page instead of asking the shopper to check the order by hand.
 */
export const CHECKOUT_STATUS_RECOVERY_CODES = new Set([
  "PAYMENT_UNKNOWN",
  "PAYMENT_IN_PROGRESS",
  "BALE_CHECKOUT_PAYMENT_EXISTS",
  "SNAPPAY_RECONCILIATION_PENDING",
  "SNAPPAY_TOKEN_DUPLICATE",
  "SNAPPAY_MANUAL_REVIEW",
]);

export function isCheckoutStatusRecoveryCode(code: string | undefined): boolean {
  return Boolean(code && CHECKOUT_STATUS_RECOVERY_CODES.has(code));
}

export function readNumericOrderId(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Prefer the order id on the failed finalize payload, then a previously stored
 * checkout identity. Never trust a client-supplied order id from the form.
 */
export function orderIdFromCheckoutFailure(source: unknown, scope?: string): number | undefined {
  const record = recordFromUnknown(source);
  const nested = recordFromUnknown(record?.data);
  const details = recordFromUnknown(record?.details);
  const detailsData = recordFromUnknown(details?.data);

  return (
    readNumericOrderId(record?.orderId) ||
    readNumericOrderId(nested?.orderId) ||
    readNumericOrderId(detailsData?.orderId) ||
    readNumericOrderId(readCheckoutIdentity(scope)?.orderId)
  );
}

export function persistPendingPaymentResult(orderId: number, attemptId?: string, scope?: string): string {
  persistCheckoutOrder(orderId, scope);
  if (!scope && typeof window !== "undefined") {
    try {
      window.localStorage.setItem("pendingOrderId", String(orderId));
      const pendingAttempt = String(attemptId || "").trim();
      if (pendingAttempt) {
        window.localStorage.setItem("pendingPaymentAttemptId", pendingAttempt);
      }
    } catch {
      // Private browsing / hardened modes can throw; navigation still works.
    }
  }
  return `/payment/result?orderId=${encodeURIComponent(String(orderId))}`;
}
