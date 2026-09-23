import * as Sentry from "@sentry/node";
import type { Strapi } from "@strapi/strapi";
import { formatCancellationReasonForSms } from "../../../services/sms/notifications";
import { consumeOrderReservation, releaseOrderReservation } from "../../../utils/stockReservations";
import { decrementStockAtomic } from "../../cart/services/lib/stock";
import {
  hasDiscountClaim,
  releaseOrderDiscountClaim,
} from "../../cart/services/lib/discount-claim";
import { consumeCheckoutCartLines } from "../../cart/services/lib/order-cart-cleanup";
import { enqueuePurchaseForOrder, enqueueRefundForReturn } from "../../report/analytics/outbox";
import { confirmReservePaymentForOrder } from "../../reserve-group/lib/reserve-group";
import { captureWalletLegForSettlement } from "../../local-user-wallet/services/wallet-holds";
import {
  captureAnipoCancelSnapshot,
  notifyAnipoParcelCancelled,
  type AnipoCancelSnapshot,
} from "../../order/controllers/helpers/notifyAnipoParcelCancelled";
import { creditWalletBalanceAtomic } from "../../local-user-wallet/services/local-user-wallet";
import { planSnappayTenderAdjustment } from "./snappay-split-tender";
import {
  recordEvidence,
  type EvidenceRow,
} from "../../payment-attempt-evidence/services/evidence";

type FinalizationIds = {
  attemptId: number;
  orderId: number;
  contractId: number;
  transactionRowId: number;
  transactionId: string;
};

type SnappayRefundTransaction = {
  id: number;
  amountIrr: number;
};

const cancellationDescription = (providerStatus: string): string => {
  switch (providerStatus) {
    case "NOT_FOUND":
      return "SnappPay reported the payment token as not found; order cancelled automatically";
    case "REGISTERED_REVERTED":
      return "SnappPay payment was never started and has been reverted; order cancelled automatically";
    default:
      return "SnappPay cancellation confirmed by provider";
  }
};

async function createSnappayRefundTransactions(
  strapi: Strapi,
  input: {
    contractId: number;
    maxStep: number;
    walletRefundIrr: number;
    gatewayRefundIrr: number;
    metadata: Record<string, unknown>;
    trx: any;
  },
): Promise<SnappayRefundTransaction[]> {
  const legs = [
    {
      key: "wallet",
      amountIrr: input.walletRefundIrr,
      externalSource: "Wallet",
      settlementGateway: "Wallet",
    },
    {
      key: "snappay",
      amountIrr: input.gatewayRefundIrr,
      externalSource: "SnappPay",
      settlementGateway: "SnappPay",
    },
  ].filter((leg) => leg.amountIrr > 0);
  const created: SnappayRefundTransaction[] = [];

  for (const [index, leg] of legs.entries()) {
    const transaction: any = await strapi.db
      .query("api::contract-transaction.contract-transaction")
      .create({
        data: {
          Type: "Return",
          Amount: leg.amountIrr,
          Step: input.maxStep + index + 1,
          Status: "Success",
          external_source: leg.externalSource,
          SettlementGateway: leg.settlementGateway,
          GatewayResponse: {
            ...input.metadata,
            refundLeg: leg.key,
            walletLegIrr: leg.key === "wallet" ? leg.amountIrr : 0,
            gatewayLegIrr: leg.key === "snappay" ? leg.amountIrr : 0,
          },
          contract: input.contractId,
          Date: new Date(),
        },
        ...(input.trx ? { transacting: input.trx } : {}),
      } as any);
    created.push({
      id: Number(transaction?.id) || 0,
      amountIrr: leg.amountIrr,
    });
  }

  return created;
}

async function creditSnappayWalletRefund(
  strapi: Strapi,
  input: {
    userId: number;
    amountIrr: number;
    reference: string;
    note: string;
    trx: any;
  },
): Promise<void> {
  if (input.amountIrr <= 0) return;
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    throw new Error("SNAPPAY_WALLET_REFUND_USER_NOT_FOUND");
  }
  const ledger = strapi.db.query(
    "api::local-user-wallet-transaction.local-user-wallet-transaction",
  );
  const existing: any = await ledger.findOne({
    where: { ReferenceId: input.reference },
    select: ["id"],
    transacting: input.trx,
  } as any);
  if (existing) return;

  const credit = await creditWalletBalanceAtomic(strapi, input.userId, input.amountIrr, input.trx);
  if (!credit.success || !credit.walletId) {
    throw new Error(credit.error || "SNAPPAY_WALLET_REFUND_FAILED");
  }
  await ledger.create({
    data: {
      Amount: input.amountIrr,
      Type: "Add",
      Date: new Date(),
      Cause: "SnappPay Order Refund",
      Note: input.note,
      ReferenceId: input.reference,
      user_wallet: credit.walletId,
    },
    transacting: input.trx,
  } as any);
}

async function incrementDiscountUsage(strapi: Strapi, order: any, trx: any): Promise<void> {
  const code = String(order?.DiscountCode || "").trim();
  if (!code) return;
  // Usage-limited coupons are claimed at checkout, inside the transaction that made the
  // discounted order durable. Counting them again here would double-charge the cap.
  if (hasDiscountClaim(order)) return;
  const discount: any = await strapi.db.query("api::discount.discount").findOne({
    where: { Code: code },
    ...(trx ? { transacting: trx } : {}),
  } as any);
  if (!discount?.id) return;
  const limit = Number(discount.LimitUsage || 0);
  const result =
    limit > 0
      ? await trx.raw(
          `UPDATE discounts
           SET used_times = used_times + 1
           WHERE id = ? AND used_times < ?
           RETURNING id`,
          [discount.id, limit],
        )
      : await trx.raw(
          `UPDATE discounts
           SET used_times = used_times + 1
           WHERE id = ?
           RETURNING id`,
          [discount.id],
        );
  if ((result?.rows || []).length !== 1) {
    throw new Error("SNAPPAY_DISCOUNT_USAGE_CONFLICT");
  }
}

/**
 * Takes stock for an order whose provider payment is already captured but whose
 * stock reservation clock has run out.
 *
 * The reservation TTL exists to stop *unpaid* checkouts pinning inventory. Once
 * SnappPay reports SETTLE the money is gone from the customer's credit, so the
 * TTL has no further authority: refusing here is how order 113678 ended up
 * Cancelled with 3,149,000 T captured (verify succeeded at 09:58:31, the sweep
 * cancelled the order at 09:59:00). We take the stock directly instead — there
 * is no reservation left to consume — and only park for an operator when the
 * goods genuinely are not there, which is the one case a human must decide.
 *
 * Note the wallet leg is captured by the caller, *after* this, to keep the
 * global lock order orders -> payment_attempts -> product_stocks -> wallet. If
 * the reservation was released rather than merely lapsed, the wallet hold went
 * back to spendable with it, and that capture then fails closed with
 * SNAPPAY_WALLET_HOLD_NOT_ACTIVE — correct, because the order really is
 * underpaid and must not ship on a refunded wallet leg.
 */
async function takeStockForSettledOrder(
  strapi: Strapi,
  ids: FinalizationIds,
  order: any,
  trx: any,
): Promise<void> {
  const items = order?.order_items || [];
  const taken: Array<{ stockId: number; quantity: number }> = [];

  for (const item of items) {
    const stockId = Number(item?.product_variation?.product_stock?.id);
    const quantity = Number(item?.Count || 0);
    if (!Number.isFinite(stockId) || stockId <= 0 || quantity <= 0) continue;

    const result = await decrementStockAtomic(strapi, stockId, quantity, trx);
    if (!result.success) {
      // Fail the whole finalization: the transaction rolls back every decrement
      // above, the attempt parks, and an operator decides between sourcing the
      // stock and refunding at the provider.
      throw new Error(`SNAPPAY_SETTLED_STOCK_UNAVAILABLE:${stockId}`);
    }
    taken.push({ stockId, quantity });
  }

  await strapi.db.query("api::order.order").update({
    where: { id: ids.orderId },
    data: { ReservationStatus: "Consumed" },
    ...(trx ? { transacting: trx } : {}),
  } as any);

  const detail = {
    orderId: ids.orderId,
    attemptId: ids.attemptId,
    transactionId: ids.transactionId,
    reservationStatus: String(order?.ReservationStatus || ""),
    stockTaken: taken,
  };
  strapi.log.warn(
    `SnappPay settled order recovered stock after its reservation lapsed ${JSON.stringify(detail)}`,
  );
  try {
    Sentry.captureMessage("snappay.settlement.reservation_lapsed_recovered", {
      level: "warning",
      tags: { area: "payment", stage: "settlement", reasonCode: "RESERVATION_LAPSED" },
      extra: detail,
    });
  } catch {
    // Reporting must never break a settlement that is otherwise complete.
  }
}

export async function finalizeSnappaySettlement(
  strapi: Strapi,
  ids: FinalizationIds,
): Promise<{ replayed: boolean }> {
  return strapi.db.transaction(async ({ trx }) => {
    await trx.raw("SELECT id FROM orders WHERE id = ? FOR UPDATE", [ids.orderId]);
    await trx.raw("SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE", [ids.attemptId]);
    await trx.raw("SELECT id FROM contract_transactions WHERE id = ? FOR UPDATE", [
      ids.transactionRowId,
    ]);

    const attempt: any = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
      where: { id: ids.attemptId },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    if (!attempt) throw new Error("SNAPPAY_ATTEMPT_NOT_FOUND");
    if (attempt.Status === "Succeeded") return { replayed: true };

    const transaction: any = await strapi.db
      .query("api::contract-transaction.contract-transaction")
      .findOne({
        where: { id: ids.transactionRowId },
        ...(trx ? { transacting: trx } : {}),
      } as any);
    if (!transaction) throw new Error("SNAPPAY_TRANSACTION_NOT_FOUND");
    if (String(transaction.GatewayStatus || "").toUpperCase() !== "SETTLE") {
      throw new Error("SNAPPAY_PROVIDER_NOT_SETTLED");
    }

    const order: any = await strapi.db.query("api::order.order").findOne({
      where: { id: ids.orderId },
      populate: {
        order_items: {
          populate: {
            product_variation: { populate: { product_stock: true } },
          },
        },
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    if (!order) throw new Error("SNAPPAY_ORDER_NOT_FOUND");
    if (["Cancelled", "Returned"].includes(String(order.Status))) {
      throw new Error("SNAPPAY_LOCAL_STATE_CONFLICT");
    }

    // Wallet leg, after stock and last in the lock order. SnappPay mixed
    // tender captures in the same transaction as provider settlement, so a
    // captured gateway leg can never sit beside an uncaptured wallet leg.
    const captureWalletLeg = async () => {
      const walletLeg = await captureWalletLegForSettlement(
        strapi,
        {
          paymentAttemptId: ids.attemptId,
          orderId: ids.orderId,
          contractId: ids.contractId,
        },
        trx,
      );
      if (walletLeg.outcome === "not_active") {
        throw new Error(`SNAPPAY_WALLET_HOLD_NOT_ACTIVE:${String(walletLeg.status)}`);
      }
    };

    const reservationStatus = String(order.ReservationStatus || "");
    if (reservationStatus === "Reserved") {
      const consumed = await consumeOrderReservation(strapi, ids.orderId, trx);
      if (consumed.outcome === "consumed") {
        await captureWalletLeg();
      } else if (consumed.expired) {
        // The clock ran out while the provider leg was in flight. See below:
        // a captured payment outranks the reservation TTL.
        await takeStockForSettledOrder(strapi, ids, order, trx);
        await captureWalletLeg();
      } else {
        throw new Error("SNAPPAY_STOCK_FINALIZATION_FAILED:reservation_not_consumed");
      }
    } else if (reservationStatus === "Expired" || reservationStatus === "Released") {
      // The reservation was already swept before we got here. Same rule.
      await takeStockForSettledOrder(strapi, ids, order, trx);
      await captureWalletLeg();
    } else if (reservationStatus !== "Consumed") {
      throw new Error(`SNAPPAY_RESERVATION_STATE_CONFLICT:${reservationStatus || "missing"}`);
    }

    await incrementDiscountUsage(strapi, order, trx);
    const now = new Date();
    await strapi.db.query("api::contract.contract").update({
      where: { id: ids.contractId },
      data: {
        Status: "Confirmed",
        Type: "Credit",
        external_source: "SnappPay",
        external_id: ids.transactionId,
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    await strapi.db.query("api::order.order").update({
      where: { id: ids.orderId },
      data: {
        Status: "Started",
        PaymentGateway: "SnappPay",
        external_source: "SnappPay",
        external_id: ids.transactionId,
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);

    // Opens the 48h combined-shipping window on the first paid order, or confirms
    // an already-bound child. No-op for non-reserve orders. Must run on every
    // paid transition: a group left PendingActivation would never get a deadline,
    // never be attachable, and hold its parcel indefinitely.
    await confirmReservePaymentForOrder(strapi as any, Number(ids.orderId), trx);
    await strapi.db.query("api::contract-transaction.contract-transaction").update({
      where: { id: ids.transactionRowId },
      data: {
        Status: "Success",
        GatewayStatus: "SETTLE",
        SettledAt: transaction.SettledAt || now,
        LastReconciledAt: now,
        VerifiedAt: transaction.VerifiedAt || now,
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    await strapi.db.query("api::payment-attempt.payment-attempt").update({
      where: { id: ids.attemptId },
      data: {
        Status: "Succeeded",
        providerStatus: "SETTLE",
        nextAction: null,
        nextActionAt: null,
        failureCode: null,
        failureMessage: null,
        lastReconciledAt: now,
        resolvedAt: now,
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    await strapi.db.query("api::order-log.order-log").create({
      data: {
        order: ids.orderId,
        Action: "Update",
        Description: "SnappPay provider settlement committed locally",
        Changes: {
          transactionId: ids.transactionId,
          providerStatus: "SETTLE",
        },
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    return { replayed: false };
  });
}

/**
 * Records a stock movement that raw SQL would otherwise not produce.
 *
 * `product-stock-log` rows are normally created by the lifecycle hook on
 * `api::product-stock.product-stock` updates (see registerAppLifecycles). The
 * restock paths below deliberately use raw `UPDATE ... SET count = count + ?` so
 * the increment is atomic, which bypasses the entity service and therefore the
 * hook — leaving these movements missing from the audit trail that every other
 * stock path records.
 */
async function logStockMovement(
  strapi: Strapi,
  trx: any,
  input: { stockId: number; quantity: number; description: string },
): Promise<void> {
  try {
    await strapi.db.query("api::product-stock-log.product-stock-log").create({
      data: {
        product_stock: input.stockId,
        Count: input.quantity,
        Type: "Add",
        Description: input.description,
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
  } catch (error: any) {
    // The stock movement itself already succeeded and is the thing that matters;
    // losing its audit row must not roll back a settlement or a cancellation.
    strapi.log.error("Failed to write SnappPay stock log", {
      stockId: input.stockId,
      error: String(error?.message || error).slice(0, 300),
    });
  }
}

async function restockConsumedOrder(strapi: Strapi, order: any, trx: any): Promise<void> {
  for (const item of order?.order_items || []) {
    const stockId = Number(item?.product_variation?.product_stock?.id);
    const quantity = Number(item?.Count || 0);
    if (!stockId || quantity <= 0) continue;
    const result = await trx.raw(
      `UPDATE product_stocks
       SET count = count + ?
       WHERE id = ?
       RETURNING id`,
      [quantity, stockId],
    );
    if ((result?.rows || []).length !== 1) {
      throw new Error("SNAPPAY_RESTOCK_FAILED");
    }
    await logStockMovement(strapi, trx, {
      stockId,
      quantity,
      description: "SnappPay order cancelled; consumed stock returned",
    });
  }
}

/**
 * Local cancellation statuses.
 *
 * `REVERT` and `CANCEL` name what SnappPay did. `NOT_FOUND` and
 * `REGISTERED_REVERTED` name why *we* ended the attempt when the provider had
 * nothing to reverse — a confirmed missing token, and an aged registered token
 * that we reverted ourselves. They are recorded strings, not new enum members:
 * `payment_attempts.providerStatus` is a free-text column.
 */
export type SnappayCancellationStatus =
  | "REVERT"
  | "CANCEL"
  | "NOT_FOUND"
  | "REGISTERED_REVERTED";

export type SnappayCancellationOptions = {
  /**
   * Names the evidence in the wallet's release reason instead of the generic
   * `reservation_Released`, so a hold released by a confirmed NOT_FOUND is
   * distinguishable from one released by a stock timeout for the rest of its
   * life.
   */
  walletReleaseReason?: string;
  /**
   * Written inside this transaction. For a decision that moves money this is
   * not optional bookkeeping: the row exists if and only if the release
   * committed, and a duplicate violates the partial unique index and aborts the
   * cancellation rather than releasing the same hold twice.
   */
  evidence?: EvidenceRow;
};

export async function applySnappayCancellation(
  strapi: Strapi,
  ids: FinalizationIds,
  providerStatus: SnappayCancellationStatus,
  reason: string,
  options: SnappayCancellationOptions = {},
): Promise<{ replayed: boolean }> {
  let anipoCancelSnapshot: AnipoCancelSnapshot | null = null;
  let cancellationRefundTransactions: SnappayRefundTransaction[] = [];
  const result = await strapi.db.transaction(async ({ trx }) => {
    await trx.raw("SELECT id FROM orders WHERE id = ? FOR UPDATE", [ids.orderId]);
    await trx.raw("SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE", [ids.attemptId]);

    const attempt: any = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
      where: { id: ids.attemptId },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    if (!attempt) throw new Error("SNAPPAY_ATTEMPT_NOT_FOUND");

    // A locally decided cancellation loses to anything that already ended the
    // attempt — including the reservation sweep, which stamps `Expired` rather
    // than `Cancelled`.
    //
    // Without this, a confirmed NOT_FOUND landing at +30:59 against a sweep
    // that won at +31:00 would sail past the narrow check below (`Expired` is
    // not `Cancelled`), re-run the release as a no-op, overwrite the attempt's
    // terminal record, and write a *second* `released` evidence row for the
    // same money — `local_ttl` and `not_found_confirmed` are different kinds,
    // so the partial unique index does not catch it and the 24-hour wallet
    // value breaker would count the same release twice.
    //
    // Scoped to the two statuses that describe a decision we made locally:
    // `REVERT`/`CANCEL` still mean "SnappPay did this", and an operator
    // cancelling a settled order must still work.
    const locallyDecided =
      providerStatus === "NOT_FOUND" || providerStatus === "REGISTERED_REVERTED";
    if (
      locallyDecided &&
      ["Succeeded", "Cancelled", "Failed", "Expired"].includes(String(attempt.Status))
    ) {
      return { replayed: true };
    }
    if (attempt.Status === "Cancelled" && attempt.providerStatus === providerStatus) {
      return { replayed: true };
    }

    const order: any = await strapi.db.query("api::order.order").findOne({
      where: { id: ids.orderId },
      populate: {
        user: true,
        order_items: {
          populate: {
            product_variation: { populate: { product_stock: true } },
          },
        },
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    if (!order) throw new Error("SNAPPAY_ORDER_NOT_FOUND");
    // Post-settle SnappPay cancel is valid through Done/Shipment. Returned orders
    // stay on the return path; Cancelled is handled by the replay check above.
    if (String(order.Status) === "Returned") {
      throw new Error("SNAPPAY_FULFILLMENT_ALREADY_STARTED");
    }

    const reservationStatus = String(order.ReservationStatus || "");
    const settledLocally =
      String(attempt.Status) === "Succeeded" && String(attempt.providerStatus) === "SETTLE";
    const contract: any = await strapi.db.query("api::contract.contract").findOne({
      where: { id: ids.contractId },
      populate: { contract_transactions: true },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    if (!contract) throw new Error("SNAPPAY_CONTRACT_NOT_FOUND");
    if (reservationStatus === "Reserved") {
      await releaseOrderReservation(strapi, ids.orderId, "Released", trx, {
        ...(options.walletReleaseReason
          ? { walletReleaseReason: options.walletReleaseReason }
          : {}),
      });
    } else if (reservationStatus === "Consumed") {
      await restockConsumedOrder(strapi, order, trx);
      await strapi.db.query("api::order.order").update({
        where: { id: ids.orderId },
        data: { ReservationStatus: "Released", ReservedUntil: null },
        ...(trx ? { transacting: trx } : {}),
      } as any);
    }

    if (settledLocally) {
      const currentTotalToman = Number(contract.Amount || 0);
      const tender = planSnappayTenderAdjustment({
        attempt,
        transactions: contract.contract_transactions || [],
        expectedOldTotalToman: currentTotalToman,
        newTotalToman: 0,
      });
      await creditSnappayWalletRefund(strapi, {
        userId: Number(order?.user?.id ?? order?.user),
        amountIrr: tender.walletRefundIrr,
        reference: `wallet-refund-order-${ids.orderId}-snappay-cancel`,
        note: String(reason || "SnappPay cancellation").slice(0, 500),
        trx,
      });
      if (tender.refundIrr > 0) {
        const siblings = contract.contract_transactions || [];
        const maxStep = siblings.reduce(
          (max: number, tx: any) => Math.max(max, Number(tx?.Step || 0)),
          0,
        );
        cancellationRefundTransactions = await createSnappayRefundTransactions(strapi, {
          contractId: ids.contractId,
          maxStep,
          walletRefundIrr: tender.walletRefundIrr,
          gatewayRefundIrr: tender.gatewayRefundIrr,
          metadata: { operation: "cancel" },
          trx,
        });
      }
    }

    const now = new Date();
    anipoCancelSnapshot = captureAnipoCancelSnapshot(order);
    const orderUpdate: Record<string, unknown> = {
      Status: "Cancelled",
      // SnappPay's diagnostic reason strings are our own internal codes (or, on
      // the operator-cancel path, an admin's own typed text) — safe to thread
      // through raw, unlike the vendor-callback-sourced reasons in gateway-helpers.ts.
      CancellationReason: formatCancellationReasonForSms(reason, "payment_gateway_declined"),
    };
    // Local Anipo void in-txn; provider «لغو شده» runs after commit.
    if (order.ShippingBarcode) {
      orderUpdate.ShippingBarcode = null;
      orderUpdate.AnipoBarcodeState = "Voided";
      orderUpdate.AnipoLastCheckedAt = now;
      orderUpdate.AnipoLastMessage = "SnappPay cancellation confirmed; local barcode cleared";
    }
    await strapi.db.query("api::order.order").update({
      where: { id: ids.orderId },
      data: orderUpdate,
      ...(trx ? { transacting: trx } : {}),
    } as any);

    // Coupon usage is returned after the order is Cancelled, because
    // releaseOrderDiscountClaim deliberately refuses to release for an order still in a
    // settled status. For a "Reserved" cancellation the claim was already handed back
    // inside releaseOrderReservation above, so this is a no-op there.
    const claimRelease = await releaseOrderDiscountClaim(strapi, ids.orderId, trx);
    if (!claimRelease.released && order.DiscountCode && attempt.Status === "Succeeded") {
      // Unlimited coupons take no checkout claim — their usage is counted at
      // settlement, so it is returned here exactly as it always was.
      await trx.raw(
        `UPDATE discounts
         SET used_times = GREATEST(0, used_times - 1)
         WHERE code = ?`,
        [order.DiscountCode],
      );
    }
    await strapi.db.query("api::contract.contract").update({
      where: { id: ids.contractId },
      data: { Status: "Cancelled" },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    await strapi.db.query("api::contract-transaction.contract-transaction").update({
      where: { id: ids.transactionRowId },
      data: {
        // A settled charge remains a historical funding fact; its Return rows
        // record the cancellation. An unpaid/reverted attempt never funded the
        // order and is correctly marked Failed.
        Status: settledLocally ? "Success" : "Failed",
        GatewayStatus: providerStatus,
        ...(providerStatus === "CANCEL" ? { CancelledAt: now } : { RevertedAt: now }),
        LastReconciledAt: now,
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    await strapi.db.query("api::payment-attempt.payment-attempt").update({
      where: { id: ids.attemptId },
      data: {
        Status: "Cancelled",
        providerStatus,
        nextAction: null,
        nextActionAt: null,
        failureCode:
          providerStatus === "NOT_FOUND"
            ? "SNAPPAY_STATUS_NOT_FOUND_TERMINAL"
            : providerStatus,
        failureMessage: cancellationDescription(providerStatus),
        resolvedAt: now,
        lastReconciledAt: now,
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    // Inside the transaction, after the release and before the commit: an
    // evidence insert that fails takes the whole cancellation with it.
    if (options.evidence) {
      await recordEvidence(strapi, options.evidence, trx);
    }

    await strapi.db.query("api::order-log.order-log").create({
      data: {
        order: ids.orderId,
        Action: "Update",
        Description: cancellationDescription(providerStatus),
        Changes: {
          transactionId: ids.transactionId,
          providerStatus,
          reason: String(reason || "").slice(0, 500),
          ...(cancellationRefundTransactions.some((transaction) => transaction.id)
            ? {
                returnTransactionIds: cancellationRefundTransactions
                  .map((transaction) => transaction.id)
                  .filter(Boolean),
              }
            : {}),
        },
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    return { replayed: false };
  });

  if (!result.replayed && anipoCancelSnapshot) {
    await notifyAnipoParcelCancelled(strapi, ids.orderId, anipoCancelSnapshot);
  }
  if (!result.replayed) {
    for (const transaction of cancellationRefundTransactions) {
      if (!transaction.id || transaction.amountIrr <= 0) continue;
      void enqueueRefundForReturn(strapi as any, {
        orderId: ids.orderId,
        contractTransactionId: transaction.id,
        amountIrr: transaction.amountIrr,
      }).catch(() => {});
    }
  }
  return result;
}

export async function runSnappaySideEffects(
  strapi: Strapi,
  attemptId: number,
  orderId: number,
): Promise<void> {
  const attempt: any = await strapi.db
    .query("api::payment-attempt.payment-attempt")
    .findOne({ where: { id: attemptId } } as any);
  if (!attempt || attempt.Status !== "Succeeded") {
    throw new Error("SNAPPAY_SIDE_EFFECTS_NOT_READY");
  }
  if (attempt.sideEffectsCompletedAt) return;

  const order: any = await strapi.db.query("api::order.order").findOne({
    where: { id: orderId },
    populate: { user: true, contract: true },
  } as any);
  if (!order) throw new Error("SNAPPAY_ORDER_NOT_FOUND");
  const userId = Number(order?.user?.id ?? order?.user);

  if (userId) {
    // Order-scoped, so items added while the customer was at SnappPay survive. This runs
    // under the existing sideEffectsCompletedAt lease; consumeCheckoutCartLines has its
    // own CartCleanupCompletedAt marker, so the two are independently idempotent and a
    // replayed lease cannot consume cart lines twice.
    await consumeCheckoutCartLines(strapi, orderId);
    const activityService: any = strapi.service("api::user-activity.user-activity");
    const existingPaymentActivity: any = await strapi.db
      .query("api::user-activity.user-activity")
      .findOne({
        where: {
          user: { id: userId },
          ActivityType: "order_payment_success",
          ResourceType: "order",
          ResourceId: String(orderId),
        },
      } as any);
    if (!existingPaymentActivity && activityService?.logPaymentSuccess) {
      await activityService.logPaymentSuccess(
        userId,
        orderId,
        Number(order?.contract?.Amount || 0),
      );
    }
  }
  // Analytics is durable-but-asynchronous; a provider/DB outage must never
  // hold the commerce side-effects lease or replay cart/stock work.
  void enqueuePurchaseForOrder(strapi as any, orderId).catch(() => undefined);
  await strapi.db.query("api::payment-attempt.payment-attempt").update({
    where: { id: attemptId },
    data: { sideEffectsCompletedAt: new Date() },
  } as any);
}

export type SnappayAdminItemChange = {
  orderItemId: number;
  oldCount: number;
  newCount: number;
  restockDelta: number;
};

export async function applySnappayAdminUpdate(
  strapi: Strapi,
  ids: FinalizationIds,
  input: {
    changes: SnappayAdminItemChange[];
    newTotalToman: number;
    newDiscountToman: number;
    newShippingToman: number;
    expectedOldTotalToman: number;
    reason: string;
    actorId: number;
    operationId?: number;
  },
): Promise<void> {
  let refundTransactions: SnappayRefundTransaction[] = [];
  await strapi.db.transaction(async ({ trx }) => {
    await trx.raw("SELECT id FROM orders WHERE id = ? FOR UPDATE", [ids.orderId]);
    await trx.raw("SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE", [ids.attemptId]);

    const attempt: any = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
      where: { id: ids.attemptId },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    const order: any = await strapi.db.query("api::order.order").findOne({
      where: { id: ids.orderId },
      populate: {
        user: true,
        order_items: {
          populate: {
            product_variation: { populate: { product_stock: true } },
          },
        },
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    const contract: any = await strapi.db.query("api::contract.contract").findOne({
      where: { id: ids.contractId },
      populate: { contract_transactions: true },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    if (
      !attempt ||
      attempt.Status !== "Succeeded" ||
      attempt.providerStatus !== "SETTLE" ||
      !order ||
      order.Status !== "Started" ||
      order.ShippingBarcode ||
      !contract ||
      Number(contract.Amount) !== Number(input.expectedOldTotalToman)
    ) {
      throw new Error("SNAPPAY_ADMIN_UPDATE_STATE_CHANGED");
    }
    if (
      !Number.isInteger(input.newTotalToman) ||
      input.newTotalToman < 0 ||
      input.newTotalToman > Number(input.expectedOldTotalToman)
    ) {
      throw new Error("SNAPPAY_ADMIN_UPDATE_AMOUNT_INVALID");
    }
    const tender = planSnappayTenderAdjustment({
      attempt,
      transactions: contract.contract_transactions || [],
      expectedOldTotalToman: input.expectedOldTotalToman,
      newTotalToman: input.newTotalToman,
    });

    const itemById = new Map((order.order_items || []).map((item: any) => [Number(item.id), item]));
    for (const change of input.changes) {
      const item: any = itemById.get(Number(change.orderItemId));
      if (
        !item ||
        Number(item.Count) !== Number(change.oldCount) ||
        !Number.isInteger(change.oldCount) ||
        !Number.isInteger(change.newCount) ||
        !Number.isInteger(change.restockDelta) ||
        change.oldCount <= 0 ||
        change.newCount < 0 ||
        change.newCount > change.oldCount ||
        change.restockDelta !== change.oldCount - change.newCount
      ) {
        throw new Error("SNAPPAY_ADMIN_UPDATE_ITEMS_CHANGED");
      }
    }

    for (const change of input.changes) {
      const item: any = itemById.get(Number(change.orderItemId));
      if (change.newCount === 0) {
        await strapi.db.query("api::order-item.order-item").delete({
          where: { id: change.orderItemId },
          ...(trx ? { transacting: trx } : {}),
        } as any);
      } else {
        await strapi.db.query("api::order-item.order-item").update({
          where: { id: change.orderItemId },
          data: { Count: change.newCount },
          ...(trx ? { transacting: trx } : {}),
        } as any);
      }
      const stockId = Number(item?.product_variation?.product_stock?.id);
      if (stockId && change.restockDelta > 0) {
        const restocked = await trx.raw(
          `UPDATE product_stocks
           SET count = count + ?
           WHERE id = ?
           RETURNING id`,
          [change.restockDelta, stockId],
        );
        if ((restocked?.rows || []).length !== 1) {
          throw new Error("SNAPPAY_ADMIN_UPDATE_RESTOCK_FAILED");
        }
        await logStockMovement(strapi, trx, {
          stockId,
          quantity: change.restockDelta,
          description: "SnappPay order adjusted by operator; stock returned",
        });
      }
    }

    await strapi.db.query("api::order.order").update({
      where: { id: ids.orderId },
      data: {
        ShippingCost: input.newShippingToman,
        AppliedDiscountAmount: input.newDiscountToman,
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    await strapi.db.query("api::contract.contract").update({
      where: { id: ids.contractId },
      data: { Amount: input.newTotalToman },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    // Record the reduction as a Return transaction rather than editing the
    // original charge down.
    //
    // Every other gateway does this (see adminAdjustItems), and the reports'
    // `paid_orders` CTE is built around it: Return rows subtract from
    // `settled_irr` and are what `refund_irr` sums. Mutating `Amount` in place
    // netted out correctly by accident but left the Refunds KPI reading zero,
    // and — because order_items are rewritten in this same transaction — made a
    // *past* date range report different numbers before and after an adjustment.
    await creditSnappayWalletRefund(strapi, {
      userId: Number(order?.user?.id ?? order?.user),
      amountIrr: tender.walletRefundIrr,
      reference: `wallet-refund-order-${ids.orderId}-snappay-update-${
        input.operationId || `${input.expectedOldTotalToman}-${input.newTotalToman}`
      }`,
      note: input.reason.slice(0, 500),
      trx,
    });
    await strapi.db.query("api::contract-transaction.contract-transaction").update({
      where: { id: ids.transactionRowId },
      data: {
        GatewayStatus: "SETTLE",
        LastReconciledAt: new Date(),
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    if (tender.refundIrr > 0) {
      const siblings: any[] = await strapi.db
        .query("api::contract-transaction.contract-transaction")
        .findMany({
          where: { contract: { id: ids.contractId } },
          ...(trx ? { transacting: trx } : {}),
        } as any);
      const maxStep = siblings.reduce((max, tx) => Math.max(max, Number(tx?.Step || 0)), 0);
      refundTransactions = await createSnappayRefundTransactions(strapi, {
        contractId: ids.contractId,
        maxStep,
        walletRefundIrr: tender.walletRefundIrr,
        gatewayRefundIrr: tender.gatewayRefundIrr,
        metadata: { operationId: input.operationId || null },
        trx,
      });
    }
    await strapi.db.query("api::payment-attempt.payment-attempt").update({
      where: { id: ids.attemptId },
      data: {
        Amount: Math.round(input.newTotalToman * 10),
        lastReconciledAt: new Date(),
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    await strapi.db.query("api::order-log.order-log").create({
      data: {
        order: ids.orderId,
        Action: "Update",
        Description: "SnappPay order update confirmed by provider",
        Changes: {
          changes: input.changes,
          fromTotal: input.expectedOldTotalToman,
          toTotal: input.newTotalToman,
          reason: input.reason.slice(0, 500),
        },
        PerformedBy: `Admin User ${input.actorId}`,
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
  });

  // Enqueue after the refund transaction commits; provider delivery is retried
  // independently and never extends the operator request.
  for (const transaction of refundTransactions) {
    if (!transaction.id || transaction.amountIrr <= 0) continue;
    void enqueueRefundForReturn(strapi as any, {
      orderId: ids.orderId,
      contractTransactionId: transaction.id,
      amountIrr: transaction.amountIrr,
    }).catch(() => {});
  }
}
