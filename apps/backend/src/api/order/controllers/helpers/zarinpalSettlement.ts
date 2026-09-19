import type { Strapi } from "@strapi/strapi";
import { consumeOrderReservation } from "../../../../utils/stockReservations";
import { decrementStockAtomic } from "../../../cart/services/lib/stock";
import {
  findOrderPaymentAttempt,
  updatePaymentAttempt,
} from "../../../payment-attempt/services/payment-attempt-store";
import { confirmReservePaymentForOrder } from "../../../reserve-group/lib/reserve-group";
import { captureWalletLegForSettlement } from "../../../local-user-wallet/services/wallet-holds";

type ZarinPalVerification = {
  refId?: string;
  alreadyVerified?: boolean;
  gatewayResponse?: unknown;
};

export class ZarinPalSettlementError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ZarinPalSettlementError";
  }
}

/**
 * Commits ZarinPal's local business result as one database transaction.
 * This helper is intentionally provider-specific so the established SnappPay
 * settlement path is not changed by the new durability rules.
 */
export async function settleZarinPalPayment(
  strapi: Strapi,
  params: {
    orderId: number;
    contractId: number;
    contractTransactionId: number;
    authority: string;
    verification: ZarinPalVerification;
  },
) {
  const {
    orderId,
    contractId,
    contractTransactionId,
    authority,
    verification,
  } = params;
  const finalReference = String(verification.refId || authority);

  return strapi.db.transaction(async ({ trx }) => {
    // Serialize duplicate callbacks on the durable local transaction. Provider
    // verification remains outside this DB transaction, so no network request
    // holds the row lock.
    await trx.raw(
      "SELECT id FROM contract_transactions WHERE id = ? FOR UPDATE",
      [contractTransactionId],
    );

    const currentTransaction: any = await strapi.db
      .query("api::contract-transaction.contract-transaction")
      .findOne({
        where: { id: contractTransactionId },
        transacting: trx,
      } as any);
    if (!currentTransaction) {
      throw new ZarinPalSettlementError(
        "ZARINPAL_TRANSACTION_NOT_FOUND",
        "Local ZarinPal transaction was not found",
      );
    }
    if (currentTransaction.Status === "Success") {
      return {
        success: true,
        replayed: true,
        finalReference: String(
          currentTransaction.GatewayRefId ||
            currentTransaction.external_id ||
            currentTransaction.GatewayAuthority ||
            authority,
        ),
      };
    }

    // Order row next, before anything is read from it, so this settlement
    // serializes against admin cancellation and reservation expiry on the same
    // row: orders -> payment_attempts -> product_stocks -> wallet.
    await trx.raw("SELECT id FROM orders WHERE id = ? FOR UPDATE", [orderId]);

    const order: any = await strapi.db.query("api::order.order").findOne({
      where: { id: orderId },
      populate: {
        order_items: {
          populate: {
            product_variation: { populate: { product_stock: true } },
          },
        },
      },
      transacting: trx,
    } as any);
    if (!order) {
      throw new ZarinPalSettlementError(
        "ZARINPAL_ORDER_NOT_FOUND",
        "Local ZarinPal order was not found",
      );
    }

    const orderStatus = String(order.Status || "");
    const reservationStatus = String(order.ReservationStatus || "None");
    if (
      ["Cancelled", "Returned"].includes(orderStatus) ||
      ["Released", "Expired"].includes(reservationStatus)
    ) {
      throw new ZarinPalSettlementError(
        "ZARINPAL_LOCAL_STATE_CONFLICT",
        `Verified payment cannot settle order ${orderStatus}/${reservationStatus}`,
      );
    }
    if (!["Paying", "Started", "Shipment", "Done"].includes(orderStatus)) {
      throw new ZarinPalSettlementError(
        "ZARINPAL_ORDER_NOT_SETTLEABLE",
        `Verified payment cannot settle order status ${orderStatus || "missing"}`,
      );
    }

    if (reservationStatus === "Reserved") {
      const consumed = await consumeOrderReservation(strapi, orderId, trx);
      if (consumed.outcome !== "consumed") {
        throw new ZarinPalSettlementError(
          "ZARINPAL_STOCK_RESERVATION_FAILED",
          consumed.expired
            ? "Stock reservation expired"
            : "Stock reservation was not consumed",
        );
      }
    } else if (reservationStatus === "None" && orderStatus === "Paying") {
      // Legacy orders predate reservations. Keep them supported, but perform
      // every decrement inside the same transaction as the payment state.
      for (const item of order.order_items || []) {
        const stockId = Number(item?.product_variation?.product_stock?.id);
        const quantity = Number(item?.Count || 0);
        if (!stockId || quantity <= 0) continue;
        const decremented = await decrementStockAtomic(
          strapi,
          stockId,
          quantity,
          trx,
        );
        if (!decremented.success) {
          throw new ZarinPalSettlementError(
            "ZARINPAL_STOCK_DECREMENT_FAILED",
            decremented.error || "Stock decrement failed",
          );
        }
      }
    } else if (!["None", "Consumed"].includes(reservationStatus)) {
      throw new ZarinPalSettlementError(
        "ZARINPAL_RESERVATION_STATE_UNKNOWN",
        `Unknown reservation status ${reservationStatus}`,
      );
    }

    // Wallet leg of a split payment, after stock and before anything else is
    // written. An inactive hold rolls this settlement back so the caller's
    // existing ZarinPal failure path runs instead of a half-paid order.
    const settlementAttempt: any = await findOrderPaymentAttempt(strapi, orderId, trx);
    if (settlementAttempt?.id) {
      const walletLeg = await captureWalletLegForSettlement(
        strapi,
        { paymentAttemptId: Number(settlementAttempt.id), orderId, contractId },
        trx,
      );
      if (walletLeg.outcome === "not_active") {
        throw new ZarinPalSettlementError(
          "ZARINPAL_WALLET_HOLD_NOT_ACTIVE",
          `Order ${orderId} wallet hold is ${String(walletLeg.status)}`,
        );
      }
    }

    await strapi.db.query("api::contract.contract").update({
      where: { id: contractId },
      data: {
        Status: "Confirmed",
        external_source: "ZarinPal",
        external_id: finalReference,
      },
      transacting: trx,
    } as any);
    await strapi.db.query("api::order.order").update({
      where: { id: orderId },
      data: {
        Status: "Started",
        external_source: "ZarinPal",
        external_id: finalReference,
      },
      transacting: trx,
    } as any);

    // Opens the 48h combined-shipping window on the first paid order, or confirms
    // an already-bound child. No-op for non-reserve orders. Must run on every
    // paid transition: a group left PendingActivation would never get a deadline,
    // never be attachable, and hold its parcel indefinitely.
    await confirmReservePaymentForOrder(strapi as any, Number(orderId), trx);
    await strapi.db
      .query("api::contract-transaction.contract-transaction")
      .update({
        where: { id: contractTransactionId },
        data: {
          Status: "Success",
          TrackId: authority,
          GatewayAuthority: authority,
          GatewayRefId: verification.refId,
          GatewayStatus: verification.alreadyVerified
            ? "ALREADY_VERIFIED"
            : "VERIFIED",
          GatewayResponse: verification.gatewayResponse,
          VerifiedAt: new Date(),
          external_id: finalReference,
          external_source: "ZarinPal",
        },
        transacting: trx,
      } as any);

    const attempt: any = settlementAttempt ?? (await findOrderPaymentAttempt(strapi, orderId, trx));
    if (attempt?.id) {
      await updatePaymentAttempt(
        strapi,
        Number(attempt.id),
        {
          Status: "Succeeded",
          providerReference: finalReference,
          providerResponse: verification.gatewayResponse,
          failureCode: null,
          failureMessage: null,
          lastReconciledAt: new Date(),
          resolvedAt: new Date(),
        },
        trx,
      );
    }

    return { success: true, replayed: false, finalReference };
  });
}
