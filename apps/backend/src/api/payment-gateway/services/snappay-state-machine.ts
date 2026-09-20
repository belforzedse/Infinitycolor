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
  /**
   * The shopper has explicitly told us they did not pay — they asked to cancel
   * this checkout so their wallet credit and stock come back.
   *
   * It is the one signal that can authorize a revert without a FAILED callback,
   * and it authorizes it only from the two states where nothing is committed
   * (`REGISTERED`, `PENDING`). It never overrides provider evidence: a token the
   * provider has already carried to `VERIFY`, `SETTLE`, `REVERT` or `CANCEL`, or
   * one whose state we could not read at all, is resolved exactly as it would be
   * without the claim. The customer knows what they did in their browser; they
   * do not know what SnappPay recorded.
   *
   * That includes their *own* earlier evidence: an `OK` callback is the shopper's
   * browser saying the payment succeeded, and it outranks the same shopper later
   * saying it did not. The provider's status legitimately lags its callbacks — it
   * is why `OK` + 1007 goes to verify above — so a token still reading `PENDING`
   * or `REGISTERED` behind an `OK` return is recovered, never reverted. Both
   * orderings reach here: the callback can land after the claim, because the two
   * share one reconcile operation.
   */
  customerAbandoned?: boolean;
  /** Age of the payment attempt. Kept for callers; age is not a terminal signal. */
  attemptAgeMs?: number | null;
  /** Unused override retained so existing test call sites keep compiling. */
  abandonAfterMs?: number;
}): SnappayRecoveryAction {
  const status = normalizeSnappayProviderStatus(input.providerStatus);
  const code = Number(input.providerCode || 0);

  if (code === 1051) return "FAIL_CONFIGURATION";

  // Workbook status/verify 1048 PAYMENT_VENTURE_MISMATCHED: the token does not
  // belong to this merchant. That is not a missing-token verify rescue, a
  // stored-page reopen, or permission to mint a replacement.
  if (code === 1048) return "MANUAL_REVIEW";

  // A validated OK callback outranks status 1007 NOT_FOUND. The customer's
  // browser came back saying the payment succeeded while SnappPay cannot find
  // the token — a contradiction that only `verify` can resolve (workbook Action
  // row for verify 1000 PENDING, Fa.txt verify). 1007 without OK is
  // investigation, not unpaid.
  if (input.callbackState === "OK" && code === 1007) {
    return "VERIFY";
  }

  // 1007 NOT_FOUND on status is not proof the payment is unpaid and does not
  // authorize local cancel, stock release, or a replacement token.
  if (code === 1007) return "MANUAL_REVIEW";

  // The two claims that a payment was not completed: the provider's own FAILED
  // callback, and the shopper telling us so. Both are only ever consulted for a
  // token the provider still reports as uncommitted, and the shopper's claim is
  // additionally void once their own browser has returned `OK` — this is the one
  // place that sees both signals at once, whichever order they arrived in.
  const unpaidClaimed =
    input.callbackState === "FAILED" ||
    (input.customerAbandoned === true && input.callbackState !== "OK");

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
      // PENDING is not unpaid. FAILED callback still needs revert (Fa.txt), and
      // so does a shopper who came back to say they abandoned the payment page.
      // Otherwise recover through verify (Action row for verify 1000).
      return unpaidClaimed ? "REVERT" : "VERIFY";
    case "REGISTERED":
      // Age is not proof the customer will not pay, so time alone never reverts
      // — but an explicit FAILED callback or the shopper's own abandonment does.
      // Without either, exhausted reconcile parks for review.
      return unpaidClaimed ? "REVERT" : "RECONCILE";
    default:
      // UNKNOWN covers "we could not read the provider at all" (a timed-out or
      // unparseable status call). Never auto-cancel a payment whose state we
      // cannot observe; keep reconciling.
      if (input.callbackState === "OK") return "VERIFY";
      return "RECONCILE";
  }
}
