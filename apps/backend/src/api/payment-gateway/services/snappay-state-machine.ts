export type SnappayProviderStatus =
  | "PENDING"
  | "REGISTERED"
  | "VERIFY"
  | "SETTLE"
  | "REVERT"
  | "CANCEL"
  | "UNKNOWN";

export type SnappayCallbackState = "OK" | "FAILED";

export type SnappayRecoveryAction =
  | "VERIFY"
  | "SETTLE"
  | "SETTLE_THEN_CANCEL"
  | "REVERT"
  | "FINALIZE_LOCAL"
  | "CANCEL_LOCAL"
  | "FAIL_CONFIGURATION"
  | "MANUAL_REVIEW"
  | "RECONCILE";

export const SNAPPAY_RECONCILIATION_DELAYS_MS = [
  5 * 60 * 1000,
  40 * 60 * 1000,
  3 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
] as const;

/**
 * Historical REGISTERED polling bound. Token age is not proof the provider
 * payment is unpaid; workers now keep reconciling REGISTERED until the schedule
 * exhausts or a FAILED callback authorizes revert. Kept so existing env/docs
 * references continue to resolve.
 */
export const SNAPPAY_ABANDON_AFTER_MS = Number(
  process.env.SNAPPAY_ABANDON_AFTER_MINUTES ||
    process.env.STOCK_RESERVATION_TTL_MINUTES ||
    30,
) * 60 * 1000;

export function normalizeSnappayProviderStatus(
  value: unknown,
): SnappayProviderStatus {
  const normalized = String(value || "").trim().toUpperCase();
  switch (normalized) {
    case "PENDING":
    case "REGISTERED":
    case "VERIFY":
    case "SETTLE":
    case "REVERT":
    case "CANCEL":
      return normalized;
    default:
      return "UNKNOWN";
  }
}

export function decideSnappayRecovery(input: {
  callbackState?: SnappayCallbackState;
  providerStatus?: unknown;
  /**
   * Provider code from the status read just performed. Only ever set when
   * SnappPay returned a parseable error envelope — a timeout or transport
   * failure leaves it undefined — so a code here always means the provider
   * answered.
   */
  providerCode?: number | null;
  /** Age of the payment attempt. Kept for callers; age is not a terminal signal. */
  attemptAgeMs?: number | null;
  /** Unused override retained so existing test call sites keep compiling. */
  abandonAfterMs?: number;
}): SnappayRecoveryAction {
  const status = normalizeSnappayProviderStatus(input.providerStatus);
  const code = Number(input.providerCode || 0);

  if (code === 1051) return "FAIL_CONFIGURATION";

  // A validated OK callback outranks an unresolvable status read. The customer's
  // browser came back saying the payment succeeded while SnappPay cannot find the
  // token — a contradiction that only `verify` can resolve (workbook Action row
  // for verify 1000 PENDING, Fa.txt verify). 1007/1048 without OK are not
  // unpaid; they are investigation outcomes (Action rows 34–35).
  if (input.callbackState === "OK" && (code === 1007 || code === 1048)) {
    return "VERIFY";
  }

  // 1007 NOT_FOUND = wrong paymentToken. 1048 PAYMENT_VENTURE_MISMATCHED = token
  // belongs to another merchant. Neither authorizes local cancel, stock release,
  // or a replacement token.
  if (code === 1007 || code === 1048) return "MANUAL_REVIEW";

  switch (status) {
    case "SETTLE":
      return "FINALIZE_LOCAL";
    case "VERIFY":
      return input.callbackState === "FAILED"
        ? "SETTLE_THEN_CANCEL"
        : "SETTLE";
    case "REVERT":
    case "CANCEL":
      return "CANCEL_LOCAL";
    case "PENDING":
      // PENDING is not unpaid. FAILED callback still needs revert (Fa.txt).
      // Otherwise recover through verify (Action row for verify 1000).
      return input.callbackState === "FAILED" ? "REVERT" : "VERIFY";
    case "REGISTERED":
      // Age is not proof the customer will not pay. Revert only after an
      // explicit FAILED callback. Exhausted reconcile parks for review.
      return input.callbackState === "FAILED" ? "REVERT" : "RECONCILE";
    default:
      // UNKNOWN covers "we could not read the provider at all" (a timed-out or
      // unparseable status call). Never auto-cancel a payment whose state we
      // cannot observe; keep reconciling.
      if (input.callbackState === "OK") return "VERIFY";
      return "RECONCILE";
  }
}
