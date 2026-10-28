/**
 * The provider-neutral reading of a payment attempt.
 *
 * Wallet-domain code — the `/me` controller, the checkout quote, the hold audit
 * — has no business knowing what a SnappPay 1007 is, and today it does not have
 * to: `payment_attempts.Status` already carries the outcome for every gateway.
 * This module makes that contract explicit so provider codes stay inside
 * `snappay-state-machine.ts` and `snappay-orchestrator.ts`.
 *
 * The four outcomes are the four things the wallet can do about an attempt:
 * capture, release, wait, or ask a human.
 */
export type PaymentAttemptOutcome =
  /** The gateway leg is confirmed; the wallet leg is captured with it. */
  | { kind: "settled" }
  /** Established as unpaid. The hold is released, naming `reason`. */
  | { kind: "terminal_unpaid"; reason: string }
  /** Still payable. Keep the hold, keep reconciling. */
  | { kind: "uncertain"; nextCheckAt: Date | null }
  /** The provider could not be read at all. Never treated as failure. */
  | { kind: "unreadable" }
  /** Needs an operator. The hold stays. */
  | { kind: "review"; code: string };

/**
 * How a hold in each outcome is described to the shopper.
 *
 * `reclaimable` is the only state where the manual button can do anything —
 * the shopper's claim that they did not pay is only consulted for a token the
 * provider still reports as uncommitted.
 */
export type WalletHoldState =
  | "reconciling"
  | "awaiting_provider"
  | "reclaimable"
  | "releasing";

const TERMINAL_UNPAID_STATUSES = ["Cancelled", "Failed", "Expired"];

/**
 * Reads an attempt row. Accepts the Strapi entity shape and the raw column
 * shape, because the audit and the read models come from raw SQL.
 */
export function outcomeFromAttemptStatus(attempt: {
  Status?: unknown;
  status?: unknown;
  nextAction?: unknown;
  next_action?: unknown;
  nextActionAt?: unknown;
  next_action_at?: unknown;
  failureCode?: unknown;
  failure_code?: unknown;
  WalletReleaseReason?: unknown;
  wallet_release_reason?: unknown;
}): PaymentAttemptOutcome {
  const status = String(attempt.Status ?? attempt.status ?? "");
  const nextAction = String(attempt.nextAction ?? attempt.next_action ?? "");
  const failureCode = String(attempt.failureCode ?? attempt.failure_code ?? "");

  if (status === "Succeeded") return { kind: "settled" };

  if (TERMINAL_UNPAID_STATUSES.includes(status)) {
    const reason = String(
      attempt.WalletReleaseReason ?? attempt.wallet_release_reason ?? "",
    );
    return { kind: "terminal_unpaid", reason: reason || failureCode || status.toLowerCase() };
  }

  if (nextAction === "manual_review") {
    return { kind: "review", code: failureCode || "MANUAL_REVIEW" };
  }

  const rawNextCheck = attempt.nextActionAt ?? attempt.next_action_at;
  const nextCheckAt = rawNextCheck ? new Date(rawNextCheck as string) : null;
  return {
    kind: "uncertain",
    nextCheckAt: nextCheckAt && Number.isFinite(nextCheckAt.getTime()) ? nextCheckAt : null,
  };
}

/**
 * The customer-facing state of a live hold.
 *
 * `review` deliberately maps to `reclaimable` rather than to something alarming:
 * a parked attempt is one the shopper *can* still resolve with the abandon
 * button, and telling them their money needs an operator when it does not would
 * be worse than saying nothing.
 */
export function walletHoldStateFor(attempt: {
  Status?: unknown;
  status?: unknown;
  nextAction?: unknown;
  next_action?: unknown;
  nextActionAt?: unknown;
  next_action_at?: unknown;
  failureCode?: unknown;
  failure_code?: unknown;
  Gateway?: unknown;
  gateway?: unknown;
}): WalletHoldState {
  const outcome = outcomeFromAttemptStatus(attempt);
  const gateway = String(attempt.Gateway ?? attempt.gateway ?? "").toLowerCase();
  const isSnappay = gateway === "snappay" || gateway === "snapppay";

  switch (outcome.kind) {
    case "settled":
      return "releasing";
    case "terminal_unpaid":
      // The attempt is over; the hold is on its way back through the release
      // hub, or already has been.
      return "releasing";
    case "review":
      return isSnappay ? "reclaimable" : "awaiting_provider";
    case "unreadable":
      return "reconciling";
    default: {
      const status = String(attempt.Status ?? attempt.status ?? "");
      // `Redirected` means the shopper is at the provider and nothing has come
      // back yet — that is waiting on them, not on us.
      if (status === "Redirected") return isSnappay ? "reclaimable" : "awaiting_provider";
      return "reconciling";
    }
  }
}

/** True when the shopper's abandon button can actually do anything. */
export const walletHoldIsReclaimable = (attempt: Parameters<typeof walletHoldStateFor>[0]): boolean =>
  walletHoldStateFor(attempt) === "reclaimable";
