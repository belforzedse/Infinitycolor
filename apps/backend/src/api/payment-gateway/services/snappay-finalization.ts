import type { Strapi } from "@strapi/strapi";
import { consumeOrderReservation, releaseOrderReservation } from "../../../utils/stockReservations";
import {
  hasDiscountClaim,
  releaseOrderDiscountClaim,
} from "../../cart/services/lib/discount-claim";
import { consumeCheckoutCartLines } from "../../cart/services/lib/order-cart-cleanup";
import { enqueuePurchaseForOrder, enqueueRefundForReturn } from "../../report/analytics/outbox";

type FinalizationIds = {
  attemptId: number;
  orderId: number;
  contractId: number;
  transactionRowId: number;
  transactionId: string;
};

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

export async function finalizeSnappaySettlement(
  strapi: Strapi,
  ids: FinalizationIds,
): Promise<{ replayed: boolean }> {
  return strapi.db.transaction(async ({ trx }) => {
    await trx.raw("SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE", [ids.attemptId]);
    await trx.raw("SELECT id FROM orders WHERE id = ? FOR UPDATE", [ids.orderId]);
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

    const reservationStatus = String(order.ReservationStatus || "");
    if (reservationStatus === "Reserved") {
      const consumed = await consumeOrderReservation(strapi, ids.orderId, trx);
      if (!consumed.success || consumed.expired || consumed.skipped) {
        throw new Error(
          `SNAPPAY_STOCK_FINALIZATION_FAILED:${
            consumed.error ||
            (consumed.expired ? "reservation_expired" : "reservation_not_consumed")
          }`,
        );
      }
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

export async function applySnappayCancellation(
  strapi: Strapi,
  ids: FinalizationIds,
  providerStatus: "REVERT" | "CANCEL",
  reason: string,
): Promise<{ replayed: boolean }> {
  return strapi.db.transaction(async ({ trx }) => {
    await trx.raw("SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE", [ids.attemptId]);
    await trx.raw("SELECT id FROM orders WHERE id = ? FOR UPDATE", [ids.orderId]);

    const attempt: any = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
      where: { id: ids.attemptId },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    if (!attempt) throw new Error("SNAPPAY_ATTEMPT_NOT_FOUND");
    if (attempt.Status === "Cancelled" && attempt.providerStatus === providerStatus) {
      return { replayed: true };
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
    if (["Shipment", "Done", "Returned"].includes(String(order.Status))) {
      throw new Error("SNAPPAY_FULFILLMENT_ALREADY_STARTED");
    }

    const reservationStatus = String(order.ReservationStatus || "");
    if (reservationStatus === "Reserved") {
      const released = await releaseOrderReservation(strapi, ids.orderId, "Released", trx);
      if (!released.success) {
        throw new Error(`SNAPPAY_RESERVATION_RELEASE_FAILED:${released.error || "unknown"}`);
      }
    } else if (reservationStatus === "Consumed") {
      await restockConsumedOrder(strapi, order, trx);
      await strapi.db.query("api::order.order").update({
        where: { id: ids.orderId },
        data: { ReservationStatus: "Released", ReservedUntil: null },
        ...(trx ? { transacting: trx } : {}),
      } as any);
    }

    const now = new Date();
    await strapi.db.query("api::order.order").update({
      where: { id: ids.orderId },
      data: { Status: "Cancelled" },
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
        Status: "Failed",
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
        failureCode: providerStatus,
        failureMessage: "SnappPay payment was cancelled",
        resolvedAt: now,
        lastReconciledAt: now,
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    await strapi.db.query("api::order-log.order-log").create({
      data: {
        order: ids.orderId,
        Action: "Update",
        Description: "SnappPay cancellation confirmed by provider",
        Changes: {
          transactionId: ids.transactionId,
          providerStatus,
          reason: String(reason || "").slice(0, 500),
        },
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    return { replayed: false };
  });
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
  },
): Promise<void> {
  let refundTransactionId: number | null = null;
  await strapi.db.transaction(async ({ trx }) => {
    await trx.raw("SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE", [ids.attemptId]);
    await trx.raw("SELECT id FROM orders WHERE id = ? FOR UPDATE", [ids.orderId]);

    const attempt: any = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
      where: { id: ids.attemptId },
      ...(trx ? { transacting: trx } : {}),
    } as any);
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
    const contract: any = await strapi.db.query("api::contract.contract").findOne({
      where: { id: ids.contractId },
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
    const refundIrr = Math.round(
      (Number(input.expectedOldTotalToman) - Number(input.newTotalToman)) * 10,
    );
    await strapi.db.query("api::contract-transaction.contract-transaction").update({
      where: { id: ids.transactionRowId },
      data: {
        GatewayStatus: "SETTLE",
        LastReconciledAt: new Date(),
      },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    if (refundIrr > 0) {
      const siblings: any[] = await strapi.db
        .query("api::contract-transaction.contract-transaction")
        .findMany({
          where: { contract: { id: ids.contractId } },
          ...(trx ? { transacting: trx } : {}),
        } as any);
      const maxStep = siblings.reduce((max, tx) => Math.max(max, Number(tx?.Step || 0)), 0);
      const returnTx: any = await strapi.db
        .query("api::contract-transaction.contract-transaction")
        .create({
          data: {
            Type: "Return",
            Amount: refundIrr,
            Step: maxStep + 1,
            Status: "Success",
            external_source: "SnappPay",
            contract: ids.contractId,
            Date: new Date(),
          },
          ...(trx ? { transacting: trx } : {}),
        } as any);
      refundTransactionId = Number(returnTx.id);
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
  const refundToman = Math.max(
    0,
    Math.round(Number(input.expectedOldTotalToman) - Number(input.newTotalToman)),
  );
  if (refundToman > 0 && refundTransactionId) {
    void enqueueRefundForReturn(strapi as any, {
      orderId: ids.orderId,
      contractTransactionId: refundTransactionId,
      amountToman: refundToman,
    }).catch(() => {});
  }
}
