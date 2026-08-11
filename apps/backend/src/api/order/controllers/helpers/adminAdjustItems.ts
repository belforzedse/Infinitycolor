import type { Strapi } from "@strapi/strapi";
import { computeTotals } from "../../../cart/services/lib/financials";
import { logAdminOrderEdit } from "../../../../utils/adminActivity";
import { getClientIp, getUserAgent } from "../../../../utils/getClientIp";
import { releaseReservedStockAtomic } from "../../../cart/services/lib/stock";
import { releaseOrderDiscountClaim } from "../../../cart/services/lib/discount-claim";
import { requireCapability } from "../../../../utils/adminAuthorization";
import {
  queueSnappayAdminCancel,
  queueSnappayAdminUpdate,
} from "../../../payment-gateway/services/snappay-orchestrator";
import { isSnappayGatewayValue } from "../../../payment-gateway/services/checkout-gateway-availability";
import { computePaidAmountToman } from "./paidAmount";
import { enqueueRefundForReturn } from "../../../report/analytics/outbox";
import {
  creditOrderRefund,
  lockOrderForAdminMutation,
  OrderChangedConcurrentlyError,
  restoreStockWithMandatoryAudit,
} from "./adminOrderIntegrity";

type ItemAdjustment = {
  orderItemId: number;
  newCount?: number;
  remove?: boolean;
};

type AdjustmentPlan = {
  orderItems: any[];
  orderItemsMap: Map<number, any>;
  changes: Array<{
    orderItemId: number;
    oldCount: number;
    newCount: number;
    productTitle: string;
    restockDelta: number;
  }>;
  newTotals: ReturnType<typeof computeTotals>;
  newShipping: number;
  oldTotal: number;
  paidAmount: number;
  refundToman: number;
  allRemoved: boolean;
};

function calculateAdjustmentPlan(
  order: any,
  items: ItemAdjustment[],
): { plan?: AdjustmentPlan; error?: "invalid_count" | "no_changes"; itemId?: number } {
  const orderItems = (order?.order_items || []) as any[];
  const orderItemsMap = new Map<number, any>(
    orderItems.map((item: any) => [Number(item.id), item]),
  );
  const changes: AdjustmentPlan["changes"] = [];

  for (const adjustment of items) {
    const item = orderItemsMap.get(Number(adjustment.orderItemId));
    if (!item) continue;
    const oldCount = Number(item.Count || 0);
    const requestedCount = adjustment.remove
      ? 0
      : Number(adjustment.newCount ?? oldCount);
    if (
      !Number.isInteger(requestedCount) ||
      requestedCount < 0 ||
      requestedCount > oldCount
    ) {
      return { error: "invalid_count", itemId: adjustment.orderItemId };
    }
    if (requestedCount !== oldCount) {
      changes.push({
        orderItemId: Number(item.id),
        oldCount,
        newCount: requestedCount,
        productTitle: item.ProductTitle || "Unknown",
        restockDelta: oldCount - requestedCount,
      });
    }
  }

  if (changes.length === 0) return { error: "no_changes" };

  const originalSubtotal = orderItems.reduce(
    (sum, item) => sum + Number(item.PerAmount || 0) * Number(item.Count || 0),
    0,
  );
  const newSubtotal = orderItems.reduce((sum, item) => {
    const change = changes.find((candidate) => candidate.orderItemId === Number(item.id));
    return sum + Number(item.PerAmount || 0) * Number(change ? change.newCount : item.Count);
  }, 0);
  const discountAmount = Number(order.AppliedDiscountAmount || 0);
  const discountRate = originalSubtotal > 0 ? discountAmount / originalSubtotal : 0;
  const effectiveDiscount = Math.max(
    0,
    Math.min(newSubtotal, Math.round(newSubtotal * discountRate)),
  );
  const newShipping = Number(order.ShippingCost || 0);
  const newTotals = computeTotals(newSubtotal, effectiveDiscount, newShipping);
  const paidAmount = computePaidAmountToman(order);
  const requestedRefund = paidAmount - Math.max(newTotals.total, 0);
  const refundToman = Math.max(0, Math.min(paidAmount, requestedRefund));
  const allRemoved = orderItems.every((item) =>
    changes.some(
      (change) => change.orderItemId === Number(item.id) && change.newCount === 0,
    ),
  );

  return {
    plan: {
      orderItems,
      orderItemsMap,
      changes,
      newTotals,
      newShipping,
      oldTotal: Number(order.contract?.Amount || 0),
      paidAmount,
      refundToman,
      allRemoved,
    },
  };
}

export async function adminAdjustItemsHandler(strapi: Strapi, ctx: any) {
  const { id } = ctx.params;
  const { items, reason } = ctx.request.body as {
    items: ItemAdjustment[];
    reason?: string;
  };
  const isDryRun = ctx.query.dryRun === "true";

  try {
    const actor = await requireCapability(ctx, strapi, "order.items.adjust");
    if (!actor) return;
    const fullUser = actor.user;
    const roleName = fullUser?.role?.name;
    if (!Array.isArray(items) || items.length === 0) {
      return ctx.badRequest("At least one item adjustment is required", {
        data: { error: "invalid_items" },
      });
    }

    const orderIdNum = Number(id);
    if (!Number.isFinite(orderIdNum)) {
      return ctx.badRequest("Invalid order id");
    }

    // Load order with all relations
    const order = await strapi.db.query("api::order.order").findOne({
      where: { id: orderIdNum },
      populate: {
        user: true,
        order_items: {
          populate: {
            product_variation: {
              populate: {
                product_stock: true,
                product: { populate: { product_main_category: true } },
              },
            },
          },
        },
        delivery_address: {
          populate: {
            shipping_city: {
              populate: {
                shipping_province: true,
              },
            },
          },
        },
        contract: {
          populate: {
            contract_transactions: true,
          },
        },
        shipping: true,
      },
    });

    if (!order) {
      return ctx.notFound("Order not found");
    }

    // Preconditions
    if (!["Paying", "Started"].includes(order.Status)) {
      return ctx.badRequest("Order status does not allow editing", {
        data: { error: "invalid_status" },
      });
    }

    if (order.ShippingBarcode) {
      return ctx.conflict("Shipping barcode exists; void it first", {
        data: { error: "barcode_exists" },
      });
    }

    const calculated = calculateAdjustmentPlan(order, items);
    if (calculated.error === "invalid_count") {
      return ctx.badRequest("Cannot increase quantity", {
        data: { error: "invalid_count", itemId: calculated.itemId },
      });
    }
    if (!calculated.plan) return ctx.badRequest("No changes to apply");
    const preflightPlan = calculated.plan;
    const {
      changes,
      newTotals,
      newShipping,
      oldTotal,
      refundToman,
      allRemoved,
    } = preflightPlan;

    if (isDryRun) {
      return {
        data: {
          preview: {
            changes,
            newTotals,
            oldTotal,
            refundToman,
            newShipping,
          },
        },
      };
    }

    const contract = order.contract;
    const txList = contract?.contract_transactions || [];
    const isSnappay =
      isSnappayGatewayValue(order.PaymentGateway) ||
      isSnappayGatewayValue(contract?.external_source) ||
      txList.some((tx: any) => isSnappayGatewayValue(tx?.external_source));

    if (isSnappay) {
      const normalizedReason = String(reason || "").trim();
      if (normalizedReason.length < 3) {
        return ctx.badRequest("Adjustment reason is required", {
          data: { error: "SNAPPAY_OPERATOR_REASON_REQUIRED" },
        });
      }
      const common = {
        orderId: orderIdNum,
        reason: normalizedReason,
        actorId: Number(fullUser.id),
        requestKey: String(ctx.request?.headers?.["x-idempotency-key"] || ""),
      };
      const operation: any = allRemoved
        ? await queueSnappayAdminCancel(strapi, common)
        : await queueSnappayAdminUpdate(strapi, {
            ...common,
            changes: changes.map(({ orderItemId, oldCount, newCount, restockDelta }) => ({
              orderItemId,
              oldCount,
              newCount,
              restockDelta,
            })),
            newTotalToman: Number(newTotals.total),
            newDiscountToman: Number(newTotals.discount),
            newShippingToman: Number(newShipping),
            expectedOldTotalToman: Number(oldTotal),
          });
      ctx.status = 202;
      return {
        data: {
          success: true,
          status: "queued",
          operationId: Number(operation.id),
          operationStatus: String(operation.Status || "Queued"),
        },
      };
    }

    // Non-SnappPay adjustments remain an atomic local wallet operation.
    const preflightUpdatedAt = new Date(order.updatedAt).getTime();
    let refundTransactionId: number | null = null;
    let committedRefundToman = 0;
    const result = await strapi.db.transaction(async ({ trx }) => {
      await lockOrderForAdminMutation(trx, orderIdNum);
      const currentOrder: any = await strapi.db.query("api::order.order").findOne({
        where: { id: orderIdNum },
        populate: {
          user: true,
          order_items: {
            populate: {
              product_variation: {
                populate: {
                  product_stock: true,
                  product: { populate: { product_main_category: true } },
                },
              },
            },
          },
          contract: { populate: { contract_transactions: true } },
        },
        transacting: trx,
      } as any);
      if (
        !currentOrder ||
        !["Paying", "Started"].includes(String(currentOrder.Status)) ||
        currentOrder.ShippingBarcode ||
        !Number.isFinite(preflightUpdatedAt) ||
        new Date(currentOrder.updatedAt).getTime() !== preflightUpdatedAt
      ) {
        throw new OrderChangedConcurrentlyError();
      }

      const currentItems = new Map<number, any>(
        (currentOrder.order_items || []).map((item: any) => [Number(item.id), item]),
      );
      for (const adjustment of items) {
        const before = preflightPlan.orderItemsMap.get(Number(adjustment.orderItemId));
        const current = currentItems.get(Number(adjustment.orderItemId));
        if (!before || !current || Number(before.Count) !== Number(current.Count)) {
          throw new OrderChangedConcurrentlyError();
        }
      }

      const recalculated = calculateAdjustmentPlan(currentOrder, items);
      if (!recalculated.plan) throw new OrderChangedConcurrentlyError();
      const currentPlan = recalculated.plan;
      const currentContract = currentOrder.contract;
      const currentContractId = Number(currentContract?.id);
      const currentTransactions = currentContract?.contract_transactions || [];
      const becameSnappay =
        isSnappayGatewayValue(currentOrder.PaymentGateway) ||
        isSnappayGatewayValue(currentContract?.external_source) ||
        currentTransactions.some((tx: any) =>
          isSnappayGatewayValue(tx?.external_source),
        );
      if (becameSnappay) throw new OrderChangedConcurrentlyError();

      committedRefundToman = currentPlan.refundToman;
      // Update or delete order items
      for (const change of currentPlan.changes) {
        if (change.newCount === 0) {
          await strapi.db
            .query("api::order-item.order-item")
            .delete({
              where: { id: change.orderItemId },
              transacting: trx,
            } as any);
        } else {
          await strapi.db.query("api::order-item.order-item").update({
            where: { id: change.orderItemId },
            data: { Count: change.newCount },
            transacting: trx,
          } as any);
        }
      }

      // Restock
      for (const change of currentPlan.changes) {
        const item = currentPlan.orderItemsMap.get(change.orderItemId) as any;
        const stockId = item?.product_variation?.product_stock?.id;
        if (stockId && change.restockDelta > 0) {
          if (currentOrder.Status === "Started") {
            await restoreStockWithMandatoryAudit(strapi, {
              stockId: Number(stockId),
              quantity: change.restockDelta,
              orderId: orderIdNum,
              cause: "Admin Order Adjustment",
              trx,
            });
          } else if (currentOrder.Status === "Paying") {
            // For unpaid orders, only release reservation (do NOT increment Count)
            if (currentOrder.ReservationStatus === "Reserved") {
              // See adminCancel: raw SQL must be handed the surrounding `trx`
              // explicitly or the release escapes this transaction.
              const releaseResult = await releaseReservedStockAtomic(
                strapi as any,
                Number(stockId),
                change.restockDelta,
                trx,
              );
              if (!releaseResult.success) {
                strapi.log.error("Failed to release reserved stock during admin adjust", {
                  orderId: orderIdNum,
                  stockId,
                  restockDelta: change.restockDelta,
                  error: releaseResult.error,
                });
                throw new Error(releaseResult.error || "RELEASE_RESERVED_STOCK_FAILED");
              }
            }
          }
        }
      }

      if (
        currentPlan.allRemoved &&
        currentOrder.Status === "Paying" &&
        currentOrder.ReservationStatus === "Reserved"
      ) {
        await releaseOrderDiscountClaim(strapi as any, orderIdNum, trx);
      }

      // Update order
      await strapi.db.query("api::order.order").update({
        where: { id: orderIdNum },
        data: {
          ShippingCost: currentPlan.newShipping,
          Status: currentPlan.allRemoved ? "Cancelled" : currentOrder.Status,
          ...(currentPlan.allRemoved && currentOrder.Status === "Paying"
            ? { ReservationStatus: "Released", ReservedUntil: null }
            : {}),
        },
        transacting: trx,
      } as any);

      // Update contract
      if (Number.isFinite(currentContractId)) {
        await strapi.db.query("api::contract.contract").update({
          where: { id: currentContractId },
          data: {
            Amount: currentPlan.allRemoved ? 0 : currentPlan.newTotals.total,
            Status: currentPlan.allRemoved ? "Cancelled" : currentContract.Status,
          },
          transacting: trx,
        } as any);
      }

      // Refund to wallet. SnappPay orders returned above and never reach here.
      const userId = Number(currentOrder.user?.id || currentOrder.user);
      if (currentPlan.refundToman > 0 && !Number.isFinite(userId)) {
        throw new Error("ORDER_REFUND_USER_NOT_FOUND");
      }
      refundTransactionId = await creditOrderRefund(strapi, {
        userId,
        orderId: orderIdNum,
        contractId: Number.isFinite(currentContractId) ? currentContractId : null,
        transactions: currentTransactions,
        refundToman: currentPlan.refundToman,
        kind: "adjust",
        note: String(reason || "") || undefined,
        trx,
      });

      // Log
      await strapi.db.query("api::order-log.order-log").create({
        data: {
          order: orderIdNum,
          Action: "Update",
          Description: currentPlan.allRemoved
            ? "Admin cancelled order (all items removed)"
            : "Admin adjusted order items",
          Changes: {
            changes: currentPlan.changes,
            refundToman: currentPlan.refundToman,
            newTotals: currentPlan.newTotals,
            reason: reason || "",
          },
          PerformedBy: `Admin User ${fullUser.id}`,
        },
        transacting: trx,
      } as any);

      // Build changes object for admin activity log
      const adminActivityChanges: Record<string, { from?: any; to?: any }> = {};
      if (currentOrder.ShippingCost !== currentPlan.newShipping) {
        adminActivityChanges.ShippingCost = {
          from: currentOrder.ShippingCost,
          to: currentPlan.newShipping,
        };
      }
      if (
        currentOrder.Status !==
        (currentPlan.allRemoved ? "Cancelled" : currentOrder.Status)
      ) {
        adminActivityChanges.Status = {
          from: currentOrder.Status,
          to: currentPlan.allRemoved ? "Cancelled" : currentOrder.Status,
        };
      }
      if (currentContract && currentContract.Amount !== currentPlan.newTotals.total) {
        adminActivityChanges.ContractAmount = {
          from: currentContract.Amount,
          to: currentPlan.newTotals.total,
        };
      }
      if (currentPlan.allRemoved) {
        adminActivityChanges.ItemsRemoved = {
          from: currentOrder.order_items?.length || 0,
          to: 0,
        };
      } else {
        currentPlan.changes.forEach((change) => {
          const item = currentPlan.orderItemsMap.get(change.orderItemId);
          if (item) {
            adminActivityChanges[`Item_${change.orderItemId}_Count`] = {
              from: item.Count,
              to: change.newCount,
            };
          }
        });
      }
      await logAdminOrderEdit(
        strapi,
        orderIdNum,
        adminActivityChanges,
        fullUser.id,
        reason,
        getClientIp(ctx),
        getUserAgent(ctx),
        roleName,
        trx,
      );

      return {
        data: {
          success: true,
          refundToman: currentPlan.refundToman,
          status: currentPlan.allRemoved ? "cancelled" : "adjusted",
        },
      };
    });

    // Enqueue only after the refund transaction commits. Delivery is retried by
    // the analytics worker and can never block the item-adjustment response.
    if (committedRefundToman > 0 && refundTransactionId) {
      void enqueueRefundForReturn(strapi as any, {
        orderId: orderIdNum,
        contractTransactionId: refundTransactionId,
        amountToman: committedRefundToman,
      }).catch(() => {});
    }

    return result;
  } catch (error: any) {
    strapi.log.error("adminAdjustItems error", error);
    const message = String(error?.message || "");

    if (error instanceof OrderChangedConcurrentlyError) {
      return ctx.conflict("Order changed concurrently", {
        data: {
          error: "ORDER_CHANGED_CONCURRENTLY",
          errorCode: "ORDER_CHANGED_CONCURRENTLY",
        },
      });
    }

    if (message.startsWith("SNAPPAY_")) {
      if (
        message === "SNAPPAY_ATTEMPT_NOT_FOUND" ||
        message === "SNAPPAY_OPERATOR_STATE_INVALID" ||
        message === "SNAPPAY_OPERATOR_OPERATION_ACTIVE"
      ) {
        return ctx.conflict("SnappPay order state changed", {
          data: { error: message },
        });
      }
      return ctx.badGateway("SnappPay synchronization failed", {
        data: { error: message },
      });
    }

    return ctx.internalServerError("Failed to adjust items", {
      data: { error: error.message },
    });
  }
}
