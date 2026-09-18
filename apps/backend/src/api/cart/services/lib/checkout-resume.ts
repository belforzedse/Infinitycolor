import {
  snappayHasInFlightDispatch,
  snappayProviderPaymentIsUnresolved,
} from "../../../payment-gateway/services/snappay-generation";
import {
  resolveEligibleCheckoutHold,
  snappayAttemptMayResumeWithoutHold,
} from "./checkout-hold";
import type { Strapi } from "@strapi/strapi";

// A dead attempt (customer backed out of the gateway, or it expired) must never be
// replayed as if it were still live -- the browser can still hold its id in
// localStorage long after the gateway/orchestrator marked it terminal, and the
// customer's next tap must start a fresh attempt instead of being handed the same
// failure forever. "Unknown" is not terminal: that is the unreadable-status hold
// where checkout must reuse the same attempt so initiate can GET /status before
// any second token. A local Failed/Cancelled/Expired SnappPay row is also not
// terminal while a provider generation may still be live.
export const TERMINAL_PAYMENT_ATTEMPT_STATUSES = new Set(["Failed", "Cancelled", "Expired"]);

export type CheckoutResumeDecision = "replay" | "conflict" | "in_progress";

export type CheckoutResumeAttempt = {
  Status?: unknown;
  quoteHash?: unknown;
  Gateway?: unknown;
  providerStatus?: unknown;
  providerResponse?: unknown;
  providerReference?: unknown;
  leaseUntil?: unknown;
  order?: unknown;
};

export function checkoutAttemptOrderId(
  attempt: { order?: unknown } | null | undefined,
): number | undefined {
  if (!attempt) return undefined;
  const order = attempt.order;
  const parsed = Number(
    order && typeof order === "object" && "id" in order
      ? (order as { id: unknown }).id
      : order,
  );
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isSnappayReplay(replay: { Gateway?: unknown }): boolean {
  return String(replay.Gateway || "").toLowerCase() === "snappay";
}

function hasLiveMintLease(replay: { leaseUntil?: unknown }): boolean {
  if (!replay.leaseUntil) return false;
  const until = new Date(String(replay.leaseUntil)).getTime();
  return Number.isFinite(until) && until > Date.now();
}

function creationIsStillOwned(replay: CheckoutResumeAttempt): boolean {
  return (
    hasLiveMintLease(replay) || snappayHasInFlightDispatch(replay.providerResponse)
  );
}

function quoteHashConflicts(replay: CheckoutResumeAttempt, expectedQuoteHash?: string): boolean {
  const expected = String(expectedQuoteHash || "").trim();
  const stored = String(replay.quoteHash || "").trim();
  // A resume without a newly calculated hash (empty-cart continuation) keeps
  // the original payable. A different hash is a different total and must not
  // reuse the stored SnapPay generation or contract amount.
  return Boolean(expected && stored && expected !== stored);
}

/**
 * Decide whether an existing payment-attempt row is the checkout being resumed.
 *
 * An empty cart after a stock hold still resumes the original attempt. A new
 * payable quote (coupon, shipping) is a new purchase: the client mints a new
 * attempt id, and this row must not be replayed at the old amount.
 */
export function existingAttemptBlocksReplacement(
  replay: CheckoutResumeAttempt,
  gateway: string,
  expectedQuoteHash?: string,
): CheckoutResumeDecision {
  if (isSnappayReplay(replay) && snappayProviderPaymentIsUnresolved(replay)) {
    // A different gateway is a new purchase with a new attempt id. Reusing this
    // row would trap the shopper on PAYMENT_IN_PROGRESS; conflict forces a mint.
    if (gateway !== "snappay") return "conflict";
    if (quoteHashConflicts(replay, expectedQuoteHash)) return "conflict";
    return "replay";
  }
  if (TERMINAL_PAYMENT_ATTEMPT_STATUSES.has(String(replay.Status || ""))) {
    return "conflict";
  }
  if (String(replay.Gateway || "").toLowerCase() !== gateway) {
    return "conflict";
  }
  if (quoteHashConflicts(replay, expectedQuoteHash)) {
    return "conflict";
  }
  return "replay";
}

export type CheckoutResumeGate =
  | CheckoutResumeDecision
  | "expired"
  | "unavailable"
  | "incomplete";

/**
 * Live attempts resume the original order when the payable quote is unchanged.
 * Expired or released reservations are not resurrected, except that an unresolved
 * SnappPay generation with the same quote still follows the existing initiate/status path.
 */
export async function gateCheckoutResume(
  strapi: Strapi,
  userId: number,
  replay: CheckoutResumeAttempt & { attemptId?: unknown },
  gateway: string,
  expectedQuoteHash?: string,
): Promise<CheckoutResumeGate> {
  const decision = existingAttemptBlocksReplacement(replay, gateway, expectedQuoteHash);
  if (decision !== "replay") return decision;
  // Unresolved SnappPay still follows initiate/status when an order exists.
  // A row that never linked an order is incomplete creation, not a payable replay.
  if (snappayAttemptMayResumeWithoutHold(replay) && checkoutAttemptOrderId(replay)) {
    return "replay";
  }

  try {
    const hold = await resolveEligibleCheckoutHold(
      strapi,
      userId,
      String(replay.attemptId || "").trim(),
    );
    if (hold.status === "held") return "replay";
    if (hold.status === "expired" || hold.status === "released") return "expired";
    if (hold.status === "ineligible") {
      // A missing order link is incomplete creation, not an expired reservation.
      if (!checkoutAttemptOrderId(replay)) {
        return creationIsStillOwned(replay) ? "in_progress" : "incomplete";
      }
      return "expired";
    }
    if (hold.status === "unavailable") return "unavailable";
    // Missing hold on a live attempt (including SnappPay Unknown before dispatch)
    // must still replay the identified checkout rather than mint a replacement.
    return "replay";
  } catch {
    return "unavailable";
  }
}

export const RESERVATION_EXPIRED_RESULT = {
  success: false as const,
  status: 409,
  errorCode: "RESERVATION_EXPIRED",
  message: "مهلت رزرو موجودی این سفارش تمام شده است. لطفاً وضعیت سفارش را بررسی کنید.",
};

export const RESERVATION_LOOKUP_FAILED_RESULT = {
  success: false as const,
  status: 503,
  errorCode: "RESERVATION_LOOKUP_FAILED",
  message: "وضعیت رزرو موجودی این سفارش الان مشخص نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.",
};

