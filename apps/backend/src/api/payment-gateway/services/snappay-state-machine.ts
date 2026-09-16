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
  providerCode?: number | null;
  /**
   * Whether the status read that produced `providerCode` actually returned a
   * payment state. Defaults to true for callers that only have a code.
   *
   * When false we have no observation of the payment at all, so `providerCode`
   * describes the failed *lookup* rather than the payment — see the 1007 note
   * below.
   */
  statusObserved?: boolean;
  /** Age of the payment attempt. Enables abandonment detection when supplied. */
  attemptAgeMs?: number | null;
  /** Override for {@link SNAPPAY_ABANDON_AFTER_MS}; mainly for tests. */
  abandonAfterMs?: number;
}): SnappayRecoveryAction {
  const status = normalizeSnappayProviderStatus(input.providerStatus);
  const code = Number(input.providerCode || 0);
  const statusObserved = input.statusObserved !== false;

  if (code === 1051) return "FAIL_CONFIGURATION";
  // 1007 (404) and 1048 are definitive only when they describe a payment we
  // actually read. A 1007 raised by a *failed* `status` call says the lookup did
  // not resolve — not that the payment failed — and treating it as definitive is
  // how a broken status endpoint cancels orders the customer may have paid for.
  // Production ran exactly that way: every one of 151 parked attempts carried
  // `httpStatus: 404, providerCode: 1007, endpoint: "status"`, and each was
  // auto-cancelled with its stock released. Unobserved codes fall through to the
  // UNKNOWN branch below, which keeps reconciling instead.
  if (statusObserved && (code === 1007 || code === 1048)) return "MANUAL_REVIEW";

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
      // unparseable status call), which is genuine ambiguity. Never auto-cancel
      // a payment whose state we cannot observe — keep reconciling.
      //
      // Exception: a validated OK callback means the provider already told us
      // the payment succeeded. `/status` cannot resolve a token before `verify`
      // has been called on it at least once, so waiting on it here would loop
      // forever. Go straight to VERIFY.
      if (input.callbackState === "OK") return "VERIFY";
      return "RECONCILE";
  }
}
