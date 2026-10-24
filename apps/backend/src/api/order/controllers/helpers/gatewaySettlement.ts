import type { Strapi } from "@strapi/strapi";
import { consumeOrderReservation } from "../../../../utils/stockReservations";
import {
  auditSystemReserveEvent,
  confirmReservePaymentForOrder,
} from "../../../reserve-group/lib/reserve-group";
import { claimPaymentAttemptForSettlement } from "../../../payment-attempt/services/payment-attempt";
import { captureWalletLegForSettlement } from "../../../local-user-wallet/services/wallet-holds";

export class GatewayLocalSettlementError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayLocalSettlementError";
  }
}

type FinalizeGatewaySettlementInput = {
  orderId: number;
  contractId: number;
  paymentAttemptId?: number;
  contractTransactionId?: number;
  gateway: "SamanKish" | "Mellat";
  /** Only the Mellat coordinator may supply its fenced, bank-confirmed recovery lease. */
  mellatLeaseVersion?: number;
  orderData?: Record<string, unknown>;
  contractData?: Record<string, unknown>;
  contractTransactionData: Record<string, unknown> & { Amount: number };
  auditDescription: string;
  auditChanges: Record<string, unknown>;
};

/**
 * Applies the local side of a provider-confirmed payment in one short transaction.
 * Provider calls must happen before this function. A failed stock, attempt, contract,
 * transaction-ledger, order, or audit mutation rejects and rolls back the whole unit.
 */
export async function finalizeGatewaySettlement(
  strapi: Strapi,
  input: FinalizeGatewaySettlementInput,
): Promise<{ outcome: "settled" | "already_settled" }> {
  let reserveOutcome: Awaited<ReturnType<typeof confirmReservePaymentForOrder>> | null = null;

  const settlement = await strapi.db.transaction(async ({ trx }) => {
    await trx.raw("SELECT id FROM orders WHERE id = ? FOR UPDATE", [input.orderId]);

    const order: any = await strapi.db.query("api::order.order").findOne({
      where: { id: input.orderId },
      select: ["id", "Status", "ReservationStatus"],
      transacting: trx,
    } as any);
    if (!order) {
      throw new GatewayLocalSettlementError("ORDER_NOT_FOUND", "Settlement order not found");
    }

    if (
      String(order.ReservationStatus) === "Consumed" &&
      ["Started", "Shipment", "Done"].includes(String(order.Status))
    ) {
      return { outcome: "already_settled" as const };
    }
    if (String(order.ReservationStatus) !== "Reserved") {
      throw new GatewayLocalSettlementError(
        "RESERVATION_NOT_ACTIVE",
        `Order ${input.orderId} reservation is ${String(order.ReservationStatus)}`,
      );
    }

    if (input.paymentAttemptId) {
      const mellatRecovery = input.gateway === "Mellat" && Number.isInteger(input.mellatLeaseVersion);
      const mellatClaim = mellatRecovery ? await trx.raw(
        `UPDATE payment_attempts SET status = 'Succeeded', updated_at = ?,
           lease_until = NULL, next_action = NULL, next_action_at = NULL,
           resolved_at = ?, provider_status = 'SETTLED',
           provider_response = jsonb_set(jsonb_set(provider_response,
             '{mellat,stockProtected}', 'false'::jsonb), '{mellat,phase}', '"completed"'::jsonb)
         WHERE id = ? AND lower(gateway) = 'mellat'
           AND status IN ('Pending', 'Redirected', 'Unknown') AND lease_version = ?
           AND lease_until > ? AND provider_response->'mellat'->>'phase' = 'settled'
           AND provider_response->'mellat'->>'stockProtected' = 'true'
           AND provider_response->'mellat'->>'saleReferenceId' = ?
           AND (provider_response->'mellat'->>'amountIrr')::numeric = ? RETURNING id`,
        [new Date(), new Date(), input.paymentAttemptId, input.mellatLeaseVersion, new Date(),
          String(input.contractTransactionData.external_id), input.contractTransactionData.Amount],
      ) : null;
      const claimed = mellatRecovery ? mellatClaim?.rows?.length === 1 :
        await claimPaymentAttemptForSettlement(strapi, input.paymentAttemptId, "Succeeded", trx);
      if (!claimed) {
        const current: any = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
          where: { id: input.paymentAttemptId },
          select: ["id", "Status"],
          transacting: trx,
        } as any);
        if (String(current?.Status) === "Succeeded") {
          return { outcome: "already_settled" as const };
        }
        throw new GatewayLocalSettlementError(
          "PAYMENT_ATTEMPT_NOT_CLAIMABLE",
          `Payment attempt ${input.paymentAttemptId} is ${String(current?.Status || "missing")}`,
        );
      }
      if (mellatRecovery) {
        // The durable processing phase retained the reservation while the bank
        // was uncertain. Refresh only this proven reservation before consuming it.
        await trx.raw("UPDATE orders SET reserved_until = ? WHERE id = ? AND reservation_status = 'Reserved'",
          [new Date(Date.now() + 60_000), input.orderId]);
      }
    }

    const consumed = await consumeOrderReservation(strapi, input.orderId, trx);
    if (consumed.outcome !== "consumed") {
      throw new GatewayLocalSettlementError(
        consumed.expired ? "RESERVATION_EXPIRED" : "RESERVATION_NOT_CONSUMED",
        `Order ${input.orderId} reservation could not be consumed`,
      );
    }

    // The wallet leg of a split payment, spent in the same transaction as the
    // provider leg. Last in the lock order, after stock. A hold that is no
    // longer active means the customer's credit went back to them (expiry,
    // cancellation) while the bank was charging: rejecting here rolls this
    // transaction back and hands the caller its existing reversal path, rather
    // than settling an order that is only half paid.
    if (input.paymentAttemptId) {
      const walletLeg = await captureWalletLegForSettlement(
        strapi,
        {
          paymentAttemptId: input.paymentAttemptId,
          orderId: input.orderId,
          contractId: input.contractId,
        },
        trx,
      );
      if (walletLeg.outcome === "not_active") {
        throw new GatewayLocalSettlementError(
          "WALLET_HOLD_NOT_ACTIVE",
          `Order ${input.orderId} wallet hold is ${String(walletLeg.status)}`,
        );
      }
    }

    await strapi.db.query("api::order.order").update({
      where: { id: input.orderId },
      data: { ...input.orderData, Status: "Started" },
      transacting: trx,
    } as any);

    // Opens the 48h combined-shipping window on the first paid order, or confirms
    // an already-bound child. No-op for non-reserve orders.
    reserveOutcome = await confirmReservePaymentForOrder(strapi, input.orderId, trx);
    await strapi.db.query("api::contract.contract").update({
      where: { id: input.contractId },
      data: { ...input.contractData, Status: "Confirmed" },
      transacting: trx,
    } as any);

    const transactionData = {
      Type: "Gateway",
      DiscountAmount: 0,
      Step: 1,
      Date: new Date(),
      ...input.contractTransactionData,
      Status: "Success",
      contract: input.contractId,
    };
    if (input.contractTransactionId) {
      await strapi.db.query("api::contract-transaction.contract-transaction").update({
        where: { id: input.contractTransactionId },
        data: transactionData,
        transacting: trx,
      } as any);
    } else {
      await strapi.db.query("api::contract-transaction.contract-transaction").create({
        data: transactionData,
        transacting: trx,
      } as any);
    }

    await strapi.db.query("api::order-log.order-log").create({
      data: {
        order: input.orderId,
        Action: "Update",
        Description: input.auditDescription,
        Changes: input.auditChanges,
      },
      transacting: trx,
    } as any);

    return { outcome: "settled" as const };
  });

  // Audited after commit: a reserve bookkeeping event must never be the reason a
  // settled payment rolls back.
  if (reserveOutcome?.outcome === "activated") {
    await auditSystemReserveEvent(
      strapi,
      {
        eventKey: "orders.reserve_group_activated",
        group: { id: reserveOutcome.groupId, groupKey: reserveOutcome.groupKey },
        changes: [
          { field: "state", label: "وضعیت", from: "PendingActivation", to: "Active" },
        ],
        metadata: { orderId: input.orderId, expiresAt: reserveOutcome.expiresAt.toISOString() },
        dedupeKey: `reserve-activated:${reserveOutcome.groupId}`,
      },
      { jobId: "payment-settlement", label: "Payment Settlement" },
    );
  } else if (reserveOutcome?.outcome === "attached") {
    await auditSystemReserveEvent(
      strapi,
      {
        eventKey: "orders.reserve_attachment_confirmed",
        group: { id: reserveOutcome.groupId, groupKey: reserveOutcome.groupKey },
        metadata: { orderId: input.orderId },
        dedupeKey: `reserve-attach-confirmed:${input.orderId}`,
      },
      { jobId: "payment-settlement", label: "Payment Settlement" },
    );
  }

  return settlement;
}
