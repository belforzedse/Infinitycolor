import type { Strapi } from "@strapi/strapi";
import { releaseOrderReservation } from "../../../../utils/stockReservations";
import { releaseWalletHoldForAttempt } from "../../../local-user-wallet/services/wallet-holds";
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
 * before it calls a gateway. This CAS competes with it on that column, so
 * exactly one wins: either the replacement wins and the old provider request
 * can never start, or initiation wins and the replacement cannot free its
 * funds. `Created` alone is not proof that nothing is in flight for SnappPay —
 * it mints a transaction id and a Pending contract transaction at creation — so
 * SnappPay predecessors and anything with a persisted provider reference are
 * refused outright.
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
              pul.user_id, pol.order_id
         FROM payment_attempts pa
         LEFT JOIN payment_attempts_user_links pul ON pul.payment_attempt_id = pa.id
         LEFT JOIN payment_attempts_order_links pol ON pol.payment_attempt_id = pa.id
        WHERE pa.attempt_id = ?
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
    if (isSnappayGatewayValue(row.gateway) || row.provider_reference) {
      return { outcome: "refused" as const, reason: "provider_bound" as const };
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
          AND status = 'Created'
          AND wallet_hold_status = 'Active'
          AND provider_reference IS NULL
        RETURNING id`,
      [row.id],
    );
    if ((claimed?.rows || []).length === 0) {
      // Initiation claimed the row first: a provider request may already be in
      // flight, so its funds and stock stay exactly where they are.
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

    const released = await releaseWalletHoldForAttempt(
      strapi,
      {
        paymentAttemptId: Number(row.id),
        userId: params.userId,
        reason: "SUPERSEDED_BY_NEW_ATTEMPT",
      },
      trx,
    );

    return {
      outcome: "superseded" as const,
      orderId,
      releasedIrr: released.outcome === "released" ? released.amountIrr : 0,
    };
  });
}
