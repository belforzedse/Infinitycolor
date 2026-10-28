import type { RecoveryMode } from "./snappay-recovery-mode";

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
  | "RECONCILE"
  /** Proven 1007, but not yet confirmable: park as today and schedule a re-read. */
  | "CONFIRM_NOT_FOUND"
  /** Proven, confirmed 1007: the local cancel that frees stock and wallet. */
  | "CANCEL_LOCAL_NOT_FOUND"
  /** Aged `REGISTERED` token: pre-checked, then reverted on SnappPay's cadence. */
  | "REVERT_REGISTERED_AGED"
  /** Provider still holds a reversible payment for a locally cancelled attempt. */
  | "LATE_SUCCESS_REVERT"
  /** Provider state cannot be reversed automatically; an operator must decide. */
  | "LATE_SUCCESS_REVIEW"
  /** Nothing to do: record what the provider said and close the operation. */
  | "OBSERVE";

export const SNAPPAY_RECONCILIATION_DELAYS_MS = [
  5 * 60 * 1000,
  40 * 60 * 1000,
  3 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
] as const;

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

/** One proven 1007 status read, as recorded in `payment_attempt_evidence`. */
export type SnappayNotFoundRead = {
  /** When the read happened, epoch ms. */
  observedAtMs: number;
  /** Age of the provider token at that read, ms. */
  tokenAgeMs: number;
};

export type SnappayNotFoundFacts = {
  /**
   * The 404 body carries nothing to correlate, so provenance is established
   * locally: the token matches the active generation, the base URL and client
   * id match the ones the token was minted against, the envelope parsed, and
   * the call neither timed out nor failed in transport.
   */
  provenanceOk: boolean;
  /** Proven reads for this attempt, oldest first, including the current one. */
  reads: SnappayNotFoundRead[];
  tokenAgeMs: number;
  minTokenAgeMs: number;
  confirmDelayMs: number;
  /** Newest redirect/resume instant, epoch ms. A resume restarts the sequence. */
  resumedAtMs: number | null;
  hasOkCallback: boolean;
};

export type SnappayNotFoundRefusal =
  | "unproven"
  | "token_too_young"
  | "too_few_reads"
  | "reads_too_close"
  | "resumed_since_first_read"
  | "ok_callback";

/**
 * `reason` is present on both outcomes rather than only on the refusal, because
 * this package compiles under Strapi's base tsconfig, which has strict null
 * checks off and will not narrow a boolean-discriminated union.
 */
export type SnappayNotFoundConfirmation = {
  confirmed: boolean;
  reason: SnappayNotFoundRefusal | "confirmed";
};

/**
 * Decides whether a 1007 has been established as terminal.
 *
 * Every clause exists because of a specific production observation. Since the
 * merge-based observation writer landed (`56177efe`, 2026-09-17), 56 of 481
 * settled attempts still carry `providerCode: 1007` beside a successful
 * `settle`, and they settled a median 4.3 minutes after the token was issued —
 * p90 10.8, max 23.4. A 1007 at +2 minutes is therefore routine for a customer
 * who is *still paying*: it means "SnappPay has no transaction record for this
 * token right now", which covers both "the shopper quit" and "the shopper has
 * not reached the first-installment bank step yet".
 *
 * So age alone is not enough (`minTokenAgeMs`, default 30 min, refused below the
 * measured tail by readiness), one read is not enough (two, spaced by
 * `confirmDelayMs`), and any sign of life — a resume of the stored payment page,
 * an OK callback — voids the sequence outright.
 */
export function evaluateSnappayNotFound(
  facts: SnappayNotFoundFacts,
): SnappayNotFoundConfirmation {
  if (!facts.provenanceOk) return { confirmed: false, reason: "unproven" };
  // The shopper's browser saying the payment succeeded outranks the provider
  // saying it has no record — that contradiction is resolved by `verify`, never
  // by a cancellation.
  if (facts.hasOkCallback) return { confirmed: false, reason: "ok_callback" };
  if (facts.tokenAgeMs < facts.minTokenAgeMs) {
    return { confirmed: false, reason: "token_too_young" };
  }
  const reads = [...facts.reads].sort((a, b) => a.observedAtMs - b.observedAtMs);
  if (reads.length < 2) return { confirmed: false, reason: "too_few_reads" };
  const first = reads[0];
  const latest = reads[reads.length - 1];
  if (latest.observedAtMs - first.observedAtMs < facts.confirmDelayMs) {
    return { confirmed: false, reason: "reads_too_close" };
  }
  // Reopening the stored payment page puts the shopper back inside the flow, so
  // everything observed before it says nothing about what they will do next.
  if (facts.resumedAtMs !== null && facts.resumedAtMs > first.observedAtMs) {
    return { confirmed: false, reason: "resumed_since_first_read" };
  }
  return { confirmed: true, reason: "confirmed" };
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
  /**
   * The order and attempt are already terminal because *we* ended them — the
   * reservation sweep, a confirmed NOT_FOUND, or an aged-REGISTERED revert.
   *
   * Nothing here may commit Infinity to fulfil such an order: `verify` is the
   * commit-to-fulfil call and the order has no stock left, so every branch that
   * would verify, settle or finalize is replaced by the late-success matrix.
   */
  locallyCancelled?: boolean;
  /** Mode for the NOT_FOUND automatic-release path. `off` keeps today's park. */
  notFoundMode?: RecoveryMode;
  /** Mode for the aged-REGISTERED revert loop. `off` keeps today's reconcile. */
  registeredMode?: RecoveryMode;
  /** Outcome of `evaluateSnappayNotFound`, computed by the caller. */
  notFound?: SnappayNotFoundConfirmation;
  /**
   * The token has been `REGISTERED` past `SNAPPAY_REGISTERED_REVERT_AFTER_MS`
   * with no callback and no resume in that window.
   */
  registeredAged?: boolean;
}): SnappayRecoveryAction {
  const status = normalizeSnappayProviderStatus(input.providerStatus);
  const code = Number(input.providerCode || 0);
  const notFoundMode = input.notFoundMode ?? "off";
  const registeredMode = input.registeredMode ?? "off";

  if (code === 1051) return "FAIL_CONFIGURATION";

  // Workbook status/verify 1048 PAYMENT_VENTURE_MISMATCHED: the token does not
  // belong to this merchant. That is not a missing-token verify rescue, a
  // stored-page reopen, or permission to mint a replacement.
  if (code === 1048) return "MANUAL_REVIEW";

  // An attempt we already ended locally can never be settled, so every branch
  // below that would commit to fulfilment is replaced. This is checked before
  // the OK-callback rescue on purpose: a late `OK` on a cancelled order is a
  // payment to reverse or refund, not an order to resurrect.
  if (input.locallyCancelled === true) {
    if (code === 1007) return "OBSERVE";
    switch (status) {
      case "PENDING":
      case "VERIFY":
        // Both are documented revert states (workbook revert row); `SETTLE` is
        // not, and settle-then-cancel would create a live installment contract
        // only to void it.
        return "LATE_SUCCESS_REVERT";
      case "SETTLE":
        // `cancel` is documented and proven from here, but voiding a live
        // installment contract is an operator's decision, not a worker's.
        return "LATE_SUCCESS_REVIEW";
      case "REVERT":
      case "CANCEL":
        return "OBSERVE";
      case "REGISTERED":
        return "RECONCILE";
      default:
        return "RECONCILE";
    }
  }

  // A validated OK callback outranks status 1007 NOT_FOUND. The customer's
  // browser came back saying the payment succeeded while SnappPay cannot find
  // the token — a contradiction that only `verify` can resolve (workbook Action
  // row for verify 1000 PENDING, Fa.txt verify). 1007 without OK is
  // investigation, not unpaid.
  if (input.callbackState === "OK" && code === 1007) {
    return "VERIFY";
  }

  // 1007 NOT_FOUND on status is not proof the payment is unpaid. With the path
  // `off` this parks for review exactly as it always has; with a mode set, the
  // confirmation protocol decides whether it has become terminal.
  if (code === 1007) {
    if (notFoundMode === "off") return "MANUAL_REVIEW";
    const notFound = input.notFound;
    if (!notFound) return "CONFIRM_NOT_FOUND";
    if (notFound.confirmed) return "CANCEL_LOCAL_NOT_FOUND";
    // A token we cannot prove is ours is an investigation, not a slow
    // confirmation: re-reading it would never make it provable.
    return notFound.reason === "unproven" ? "MANUAL_REVIEW" : "CONFIRM_NOT_FOUND";
  }

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
      // An explicit FAILED callback or the shopper's own abandonment reverts
      // immediately. Otherwise a token that has sat `REGISTERED` past the
      // configured age is reverted on SnappPay's documented 30-minute cadence
      // (workbook revert/1011 from `registered`: "consider the order not
      // finalized and wait 30 min to revert it again"). Revert cannot touch a
      // `registered` token, so the loop cannot kill a session a shopper is
      // still inside — it can only establish that there is nothing to kill.
      if (unpaidClaimed) return "REVERT";
      if (input.registeredAged === true && registeredMode !== "off") {
        return "REVERT_REGISTERED_AGED";
      }
      return "RECONCILE";
    default:
      // UNKNOWN covers "we could not read the provider at all" (a timed-out or
      // unparseable status call). Never auto-cancel a payment whose state we
      // cannot observe; keep reconciling.
      if (input.callbackState === "OK") return "VERIFY";
      return "RECONCILE";
  }
}
