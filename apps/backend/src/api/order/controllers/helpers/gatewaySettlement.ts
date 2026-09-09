import type { Strapi } from "@strapi/strapi";
import { consumeOrderReservation } from "../../../../utils/stockReservations";
import {
  auditSystemReserveEvent,
  confirmReservePaymentForOrder,
} from "../../../reserve-group/lib/reserve-group";
import { claimPaymentAttemptForSettlement } from "../../../payment-attempt/services/payment-attempt";

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
      const claimed = await claimPaymentAttemptForSettlement(
        strapi,
        input.paymentAttemptId,
        "Succeeded",
        trx,
      );
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
    }

    const consumed = await consumeOrderReservation(strapi, input.orderId, trx);
    if (consumed.outcome !== "consumed") {
      throw new GatewayLocalSettlementError(
        consumed.expired ? "RESERVATION_EXPIRED" : "RESERVATION_NOT_CONSUMED",
        `Order ${input.orderId} reservation could not be consumed`,
      );
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
