import type { Strapi } from "@strapi/strapi";
import { releaseOrderReservation } from "../../../../utils/stockReservations";
import {
  isSupersedableHoldRow,
  releaseWalletHoldForAttempt,
} from "../../../local-user-wallet/services/wallet-holds";
import { isSnappayGatewayValue } from "../../../payment-gateway/services/checkout-gateway-availability";

export type SupersedeOutcome =
  | { outcome: "superseded"; orderId: number | null; releasedIrr: number }
  | {
      outcome: "refused";
      reason:
        | "not_found"
        | "not_owner"
        | "no_hold"
        | "in_flight"
        | "self"
        | "provider_bound";
    };

/**
 * Releases one *named* earlier checkout so its wallet credit and stock go back
 * to the customer who owns them.
 *
 * This is deliberately not "cancel every `Created` attempt this customer has".
 * A customer may legitimately have two independent checkouts open in two tabs,
 * and finalizing one must never cancel the other or borrow its reservation. The
 * storefront therefore names the attempt it is replacing — the one it just
 * stashed when the quote changed — and the server validates that lineage:
 * same owner, still `Created`, still holding wallet credit, and never handed to
 * a provider.
 *
 * ## Racing the provider
 * `claimPaymentAttemptForInitiation` CASes the same row `Created → Pending`
 * before it calls a gateway, and `claimPaymentAttemptForSettlement` CASes
 * `Pending`/`Redirected → Succeeded`/`Failed` when a callback lands. This CAS
 * competes with both on that one column, so exactly one wins: either the
 * replacement wins and the predecessor can never start or settle, or the
 * provider path wins and the replacement cannot free its funds. A shopper whose
 * payment went through while they were re-checking-out is therefore told so,
 * rather than losing the money.
 *
 * An abandoned bank checkout rests at `Redirected` with a provider reference,
 * and that is reclaimable: the bank's callback rides the shopper's own browser,
 * so anyone who actually paid was carried forward through settlement instead of
 * back to the cart. SnappPay is the exception and is refused outright — it mints
 * a transaction id at creation, reports `PENDING` long after the shopper has
 * gone, and must not be probed synchronously on the checkout path. Its hold is
 * reclaimed by a queued cancel operation instead, which the caller asks for
 * through `requestProviderHoldRelease` below when this refuses with
 * `provider_bound`.
 *
 * ## Stock
 * This runs in its own transaction, before the replacement reserves anything.
 * Releasing first is what lets a customer holding the last unit of an item
 * re-quote it at all. The freed stock is genuinely free in the interval, so
 * another shopper may take it and the replacement then fails the ordinary
 * stock check — which is the correct, fail-closed outcome, and is why the two
 * reservations are never coordinated by treating the old one as "still ours".
 */
export async function supersedeCheckoutAttempt(
  strapi: Strapi,
  params: { userId: number; attemptId: string; replacementAttemptId: string },
): Promise<SupersedeOutcome> {
  const attemptId = String(params.attemptId || "").trim();
  if (!attemptId) return { outcome: "refused", reason: "not_found" };
  if (attemptId === String(params.replacementAttemptId || "").trim()) {
    return { outcome: "refused", reason: "self" };
  }

  return strapi.db.transaction(async ({ trx }) => {
    const candidate = await trx.raw(
      `SELECT pa.id, pa.status, pa.gateway, pa.provider_reference, pa.wallet_hold_status,
              pa.wallet_amount, pul.user_id, pol.order_id
         FROM payment_attempts pa
         LEFT JOIN payment_attempts_user_links pul ON pul.payment_attempt_id = pa.id
         LEFT JOIN payment_attempts_order_links pol ON pol.payment_attempt_id = pa.id
         LEFT JOIN orders o ON o.id = pol.order_id
        WHERE pa.attempt_id = ?
          AND o.bale_checkout_id IS NULL
        LIMIT 1`,
      [attemptId],
    );
    const row = candidate?.rows?.[0];
    if (!row) return { outcome: "refused" as const, reason: "not_found" as const };
    if (Number(row.user_id) !== Number(params.userId)) {
      return { outcome: "refused" as const, reason: "not_owner" as const };
    }
    if (row.wallet_hold_status !== "Active") {
      return { outcome: "refused" as const, reason: "no_hold" as const };
    }
    if (isSnappayGatewayValue(row.gateway)) {
      return { outcome: "refused" as const, reason: "provider_bound" as const };
    }
    // Belt and braces on the shared predicate: whatever the reasons above do
    // not cover, this refuses rather than releasing on a stale read. The quote
    // credits exactly what this admits.
    if (!isSupersedableHoldRow(row)) {
      return { outcome: "refused" as const, reason: "in_flight" as const };
    }

    const orderId = Number(row.order_id) || null;
    // Order first, to keep the global lock order (orders -> attempts -> stock
    // -> wallet) even though this attempt has already been identified.
    if (orderId) {
      await trx.raw("SELECT id FROM orders WHERE id = ? FOR UPDATE", [orderId]);
    }

    const claimed = await trx.raw(
      `UPDATE payment_attempts
          SET status = 'Cancelled',
              failure_code = 'SUPERSEDED_BY_NEW_ATTEMPT',
              failure_message = 'Replaced by a newer checkout attempt from the same customer',
              resolved_at = NOW(),
              updated_at = NOW()
        WHERE id = ?
          AND status IN ('Created', 'Redirected')
          AND wallet_hold_status = 'Active'
        RETURNING id`,
      [row.id],
    );
    if ((claimed?.rows || []).length === 0) {
      // Initiation or settlement claimed the row first: a provider request is
      // in flight, or the shopper's payment has already landed, so its funds
      // and stock stay exactly where they are.
      return { outcome: "refused" as const, reason: "in_flight" as const };
    }

    if (orderId) {
      await releaseOrderReservation(strapi, orderId, "Released", trx, {
        userId: params.userId,
      });
      await strapi.db.query("api::order.order").update({
        where: { id: orderId },
        data: { Status: "Cancelled" },
        transacting: trx,
      } as any);
      await strapi.db.query("api::order-log.order-log").create({
        data: {
          order: orderId,
          Action: "Update",
          Description: "Checkout superseded by a newer attempt from the same customer",
          Changes: { attemptId, replacedBy: params.replacementAttemptId },
        },
        transacting: trx,
      } as any);
    }

    // Releasing the reservation above already gives the hold back, because the
    // hold's lifetime is the reservation's. This call is what covers an attempt
    // that never reached an order, and is a no-op otherwise.
    const released = await releaseWalletHoldForAttempt(
      strapi,
      {
        paymentAttemptId: Number(row.id),
        userId: params.userId,
        reason: "SUPERSEDED_BY_NEW_ATTEMPT",
      },
      trx,
    );

    // Either path returned the same money, and this transaction either commits
    // both or neither — so report what stopped being held, not which statement
    // happened to do it.
    const heldIrr = Math.max(0, Number(row.wallet_amount) || 0);
    return {
      outcome: "superseded" as const,
      orderId,
      releasedIrr: released.outcome === "released" ? released.amountIrr : heldIrr,
    };
  });
}

/**
 * Asks the queue to resolve a *SnappPay* predecessor so its wallet hold comes
 * back, and reports whether the request was accepted.
 *
 * `supersedeCheckoutAttempt` refuses these outright, for good reasons that have
 * not changed: SnappPay mints a transaction id the moment an attempt exists, it
 * keeps answering `REGISTERED` long after the shopper has walked away, and a
 * synchronous provider call on the checkout path is a known outage mode here.
 * So nothing about the hold is decided inline. What the shopper naming this
 * predecessor *does* establish is that they did not complete that payment — the
 * one piece of evidence the reconciliation state machine was missing — and that
 * is what gets queued. The worker still reads `GET /status` before acting, and a
 * payment SnappPay says happened is settled and honoured instead.
 *
 * Returning `false` means nothing was queued (not this shopper's attempt, not
 * SnappPay, no live hold, or the queue refused), and the caller must not promise
 * the customer that credit is on its way back.
 */
export async function requestProviderHoldRelease(
  strapi: Strapi,
  userId: number,
  attemptId: string,
): Promise<boolean> {
  const trimmed = String(attemptId || "").trim();
  if (!trimmed) return false;

  const candidate = await strapi.db.connection.raw(
    `SELECT pa.gateway, pa.wallet_hold_status, pol.order_id
       FROM payment_attempts pa
       JOIN payment_attempts_user_links pul ON pul.payment_attempt_id = pa.id
       LEFT JOIN payment_attempts_order_links pol ON pol.payment_attempt_id = pa.id
       LEFT JOIN orders o ON o.id = pol.order_id
      WHERE pa.attempt_id = ?
        AND pul.user_id = ?
        AND o.bale_checkout_id IS NULL
      LIMIT 1`,
    [trimmed, userId],
  );
  const row = candidate?.rows?.[0];
  if (!row) return false;
  // Only ever for a live hold on a SnappPay attempt: everything else either has
  // no money committed or is already reclaimable inline.
  if (row.wallet_hold_status !== "Active") return false;
  if (!isSnappayGatewayValue(row.gateway)) return false;
  const orderId = Number(row.order_id);
  if (!Number.isInteger(orderId) || orderId <= 0) return false;

  try {
    const outcome = await strapi
      .service("api::payment-gateway.snappay-orchestrator")
      .abandonOrder(orderId, "customer_replaced_checkout");
    // Refused when the predecessor is already resolved or its own `OK` return
    // has landed; there is then no release to wait for, so say so rather than
    // sending the shopper back to retry a checkout that will keep refusing.
    if (outcome?.accepted !== true) return false;
    strapi.log.info(
      `Queued a SnappPay abandonment for attempt ${trimmed} (order ${orderId}) so user ${userId} can spend their wallet credit again`,
    );
    return true;
  } catch (error: any) {
    // The replacement checkout is still refused for held funds either way; this
    // only decides which refusal the shopper is told.
    strapi.log.error(
      `Failed to queue a SnappPay abandonment for attempt ${trimmed}: ${String(
        error?.message || error,
      ).slice(0, 300)}`,
    );
    return false;
  }
}
