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
 * How long a `REGISTERED` (issued but never paid) token is treated as a payment
 * the customer might still complete.
 *
 * Past this the checkout is abandoned: the provider never took money, so there is
 * nothing ambiguous to adjudicate and no reason to involve a human. We revert the
 * unpaid token and release the stock instead of polling for ~40h and then parking
 * the attempt for manual review.
 *
 * Defaults to the stock-reservation TTL, because once the reservation has lapsed
 * the customer's checkout is over by definition.
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
  /** Age of the payment attempt. Enables abandonment detection when supplied. */
  attemptAgeMs?: number | null;
  /** Override for {@link SNAPPAY_ABANDON_AFTER_MS}; mainly for tests. */
  abandonAfterMs?: number;
}): SnappayRecoveryAction {
  const status = normalizeSnappayProviderStatus(input.providerStatus);
  const code = Number(input.providerCode || 0);

  if (code === 1051) return "FAIL_CONFIGURATION";

  // A validated OK callback outranks an unresolvable status read. The customer's
  // browser came back saying the payment succeeded while SnappPay cannot find the
  // token — a contradiction that only `verify` can resolve, since it is the call
  // that actually confirms the payment rather than merely reporting on it.
  //
  // This terminates either way: `performVerify` settles on success, and on a
  // failed verify it re-reads status and routes 1007/1048 to `markManualReview`
  // rather than back to RECONCILE, so there is no status→verify→status loop.
  // A NOT_FOUND from verify simply confirms the abandonment.
  //
  // This is the rescue path for the genuinely-paid-but-unresolvable case —
  // ~1-in-276 on production — and it must sit ahead of the 1007 branch below.
  if (input.callbackState === "OK" && (code === 1007 || code === 1048)) {
    return "VERIFY";
  }

  // 1007 NOT_FOUND ("the payment token sent is wrong") and 1048
  // PAYMENT_VENTURE_MISMATCHED are definitive, and manual review is the action
  // SnappPay's own error workbook prescribes for both
  // (docs/snappay/Rest API Documents/SnappPay Error Codes - full version.xlsx).
  //
  // 1007 on `status` is what an abandoned checkout looks like: the sibling
  // `update` row defines the same condition as "this payment token never reached
  // the bank payment gateway for the first installment". Verified on production
  // 2026-09-16 — status() returns HTTP 200 for 64% of attempts (275 SETTLE, 83
  // REVERT, 3 PENDING), and 93% of the 404/1007 population never sent a callback
  // at all. No money was taken for these; cancelling them and releasing their
  // stock is the correct outcome, not a lost order.
  if (code === 1007 || code === 1048) return "MANUAL_REVIEW";

  const abandonAfterMs = Number(input.abandonAfterMs ?? SNAPPAY_ABANDON_AFTER_MS);
  const age = Number(input.attemptAgeMs ?? NaN);
  const abandoned = Number.isFinite(age) && age > abandonAfterMs;

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
      return input.callbackState === "FAILED" ? "REVERT" : "VERIFY";
    case "REGISTERED":
      // The provider never took money for a REGISTERED token. A FAILED callback
      // says so explicitly; an attempt older than the abandonment window says so
      // by omission — the customer redirected and never came back. Both revert.
      return input.callbackState === "FAILED" || abandoned ? "REVERT" : "RECONCILE";
    default:
      // UNKNOWN covers "we could not read the provider at all" (a timed-out or
      // unparseable status call), which is genuine ambiguity — no provider code
      // was returned, so the branches above did not fire. Never auto-cancel a
      // payment whose state we cannot observe; keep reconciling.
      //
      // A validated OK callback still means the provider told us the payment
      // succeeded, so go straight to VERIFY rather than polling a status we
      // cannot read.
      if (input.callbackState === "OK") return "VERIFY";
      return "RECONCILE";
  }
}
