import type { Strapi } from "@strapi/strapi";
import { computeTotals } from "../../../cart/services/lib/financials";
import { logAdminOrderEdit } from "../../../../utils/adminActivity";
import { getClientIp, getUserAgent } from "../../../../utils/getClientIp";
import { releaseReservedStockAtomic } from "../../../cart/services/lib/stock";
import { requireCapability } from "../../../../utils/adminAuthorization";
import {
  queueSnappayAdminCancel,
  queueSnappayAdminUpdate,
} from "../../../payment-gateway/services/snappay-orchestrator";
import { isSnappayGatewayValue } from "../../../payment-gateway/services/checkout-gateway-availability";
import { computePaidAmountToman } from "./paidAmount";
import { trackRefundToMatomo } from "../../../report/services/matomo-tracker";

type ItemAdjustment = {
  orderItemId: number;
  newCount?: number;
  remove?: boolean;
};

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

    // Normalize typing for TS (Strapi returns unknown)
    const orderItemsArr = (order.order_items || []) as any[];

    // Validate and compute changes
    const orderItemsMap = new Map(orderItemsArr.map((it: any) => [it.id, it]));
    const changes: Array<{
      orderItemId: number;
      oldCount: number;
      newCount: number;
      productTitle: string;
      restockDelta: number;
    }> = [];

    for (const adj of items) {
      const item = orderItemsMap.get(adj.orderItemId);
      if (!item) continue;

      const oldCount = Number(item.Count || 0);
      const requestedCount = adj.remove
        ? 0
        : Number(adj.newCount ?? oldCount);
      if (
        !Number.isInteger(requestedCount) ||
        requestedCount < 0 ||
        requestedCount > oldCount
      ) {
        return ctx.badRequest("Cannot increase quantity", {
          data: { error: "invalid_count", itemId: adj.orderItemId },
        });
      }
      const newCount = requestedCount;

      if (newCount !== oldCount) {
        changes.push({
          orderItemId: item.id,
          oldCount,
          newCount,
          productTitle: item.ProductTitle || "Unknown",
          restockDelta: oldCount - newCount,
        });
      }
    }

    if (changes.length === 0) {
      return ctx.badRequest("No changes to apply");
    }

    const originalSubtotal = orderItemsArr.reduce(
      (sum, it: any) => sum + Number(it.PerAmount || 0) * Number(it.Count || 0),
      0,
    );

    // Recompute financials
    let newSubtotal = 0;
    for (const it of orderItemsArr) {
      const change = changes.find((c) => c.orderItemId === it.id);
      const count = change ? change.newCount : it.Count;
      newSubtotal += Number(it.PerAmount || 0) * count;
    }

    // Reuse original discount
    const discountAmount = Number(order.AppliedDiscountAmount || 0);

    // Recalculate shipping if Anipo (disabled – leave original logic commented for reference)
    let newShipping = Number(order.ShippingCost || 0);
    /*
    const shipping = order.shipping;
    if (shipping && shipping.Title?.toLowerCase().includes("anipo")) {
      const cityCode = order.delivery_address?.shipping_city?.Code;
      if (cityCode) {
        let totalWeight = 0;
        for (const it of orderItemsArr) {
          const change = changes.find((c) => c.orderItemId === it.id);
          const count = change ? change.newCount : it.Count;
          const weight = Number(it.product_variation?.product?.Weight || 100);
          totalWeight += weight * count;
        }

        const anipo = strapi.service("api::shipping.anipo");
        const priceRes = await anipo.barcodePrice({
          cityCode: Number(cityCode),
          weight: totalWeight || 100,
          sum: newSubtotal * 10, // IRR
        });

        if (priceRes.ok && typeof priceRes.price === "number") {
          newShipping = Math.round(priceRes.price / 10); // toman
        }
      }
    }
    */

    // Tax is completely disabled (always 0)
    const discountRate = originalSubtotal > 0 ? discountAmount / originalSubtotal : 0;
    const effectiveDiscount = Math.max(
      0,
      Math.min(newSubtotal, Math.round(newSubtotal * discountRate)),
    );
    const newTotals = computeTotals(newSubtotal, effectiveDiscount, newShipping);

    const oldTotal = Number(order.contract?.Amount || 0);
    const paidAmount = computePaidAmountToman(order);
    const requestedRefund = paidAmount - Math.max(newTotals.total, 0);
    // Calculate refund (tax is disabled, so no tax exclusion)
    const refundToman = Math.max(0, Math.min(paidAmount, requestedRefund));

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

    // Check if all items removed
    const allRemoved = order.order_items.every((it: any) =>
      changes.some((c) => c.orderItemId === it.id && c.newCount === 0),
    );
    const contract = order.contract;
    const contractIdNum = Number(contract?.id);
    const txList = contract?.contract_transactions || [];
    const isSnappay =
      isSnappayGatewayValue(order.PaymentGateway) ||
      isSnappayGatewayValue(contract?.external_source) ||
      txList.some((tx: any) =>
        isSnappayGatewayValue(tx?.external_source),
      );

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
        requestKey: String(
          ctx.request?.headers?.["x-idempotency-key"] || "",
        ),
      };
      const operation: any = allRemoved
        ? await queueSnappayAdminCancel(strapi, common)
        : await queueSnappayAdminUpdate(strapi, {
            ...common,
            changes: changes.map(
              ({ orderItemId, oldCount, newCount, restockDelta }) => ({
                orderItemId,
                oldCount,
                newCount,
                restockDelta,
              }),
            ),
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
    let refundTransactionId: number | null = null;
    const result = await strapi.db.transaction(async () => {
      // Update or delete order items
      for (const change of changes) {
        if (change.newCount === 0) {
          await strapi.db
            .query("api::order-item.order-item")
            .delete({ where: { id: change.orderItemId } });
        } else {
          await strapi.db.query("api::order-item.order-item").update({
            where: { id: change.orderItemId },
            data: { Count: change.newCount },
          });
        }
      }

      // Restock
      for (const change of changes) {
        const item = orderItemsMap.get(change.orderItemId) as any;
        const stockId = item?.product_variation?.product_stock?.id;
        if (stockId && change.restockDelta > 0) {
          if (order.Status === "Started") {
            const stock = await strapi.db
              .query("api::product-stock.product-stock")
              .findOne({ where: { id: stockId } });
            if (stock) {
              await strapi.db.query("api::product-stock.product-stock").update({
                where: { id: stockId },
                data: { Count: Number(stock.Count || 0) + change.restockDelta },
              });
            }
          } else if (order.Status === "Paying") {
            // For unpaid orders, only release reservation (do NOT increment Count)
            if (order.ReservationStatus === "Reserved") {
              const releaseResult = await releaseReservedStockAtomic(
                strapi as any,
                Number(stockId),
                change.restockDelta
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

      // Update order
      await strapi.db.query("api::order.order").update({
        where: { id: orderIdNum },
        data: {
          ShippingCost: newShipping,
          Status: allRemoved ? "Cancelled" : order.Status,
        },
      });

      // Update contract
      if (Number.isFinite(contractIdNum)) {
        await strapi.db.query("api::contract.contract").update({
          where: { id: contractIdNum },
          data: {
            Amount: allRemoved ? 0 : newTotals.total,
            Status: allRemoved ? "Cancelled" : contract.Status,
          },
        });
      }

      // Refund to wallet. SnappPay orders returned above and never reach here.
      {
        const userId = order.user?.id || order.user;
        let wallet = await strapi.db
          .query("api::local-user-wallet.local-user-wallet")
          .findOne({ where: { user: userId } });

        if (!wallet) {
          wallet = await strapi.db.query("api::local-user-wallet.local-user-wallet").create({
            data: {
              user: userId,
              Balance: 0,
              LastTransactionDate: new Date(),
            },
          });
        }

        const refundIrr = refundToman * 10;
        await strapi.db.query("api::local-user-wallet.local-user-wallet").update({
          where: { id: wallet.id },
          data: {
            Balance: Number(wallet.Balance || 0) + refundIrr,
            LastTransactionDate: new Date(),
          },
        });

        await strapi.db
          .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
          .create({
            data: {
              Amount: refundIrr,
              Type: "Add",
              Date: new Date(),
              Cause: allRemoved ? "Order Cancelled (Admin)" : "Order Adjustment (Admin)",
              ReferenceId: `order-${orderIdNum}-adj-${Date.now()}`,
              user_wallet: wallet.id,
            },
          });

        // Create contract-transaction Return record
        const maxStep =
          txList.length > 0 ? Math.max(...txList.map((t: any) => Number(t.Step || 0))) : 0;

        if (Number.isFinite(contractIdNum)) {
          const returnTx = await strapi.db
            .query("api::contract-transaction.contract-transaction")
            .create({
              data: {
                Type: "Return",
                Amount: refundIrr,
                Step: maxStep + 1,
                Status: "Success",
                external_source: "System",
                contract: contractIdNum,
                Date: new Date(),
              },
            });
          refundTransactionId = Number(returnTx.id);
        }
      }

      // Log
      await strapi.db.query("api::order-log.order-log").create({
        data: {
          order: orderIdNum,
          Action: "Update",
          Description: allRemoved
            ? "Admin cancelled order (all items removed)"
            : "Admin adjusted order items",
          Changes: {
            changes,
            refundToman,
            newTotals,
            reason: reason || "",
          },
          PerformedBy: `Admin User ${fullUser.id}`,
        },
      });

      // Build changes object for admin activity log
      const adminActivityChanges: Record<string, { from?: any; to?: any }> = {};
      if (order.ShippingCost !== newShipping) {
        adminActivityChanges.ShippingCost = {
          from: order.ShippingCost,
          to: newShipping,
        };
      }
      if (order.Status !== (allRemoved ? "Cancelled" : order.Status)) {
        adminActivityChanges.Status = {
          from: order.Status,
          to: allRemoved ? "Cancelled" : order.Status,
        };
      }
      if (contract && contract.Amount !== newTotals.total) {
        adminActivityChanges.ContractAmount = {
          from: contract.Amount,
          to: newTotals.total,
        };
      }
      if (allRemoved) {
        adminActivityChanges.ItemsRemoved = {
          from: order.order_items?.length || 0,
          to: 0,
        };
      } else {
        changes.forEach((change) => {
          const item = orderItemsMap.get(change.orderItemId);
          if (item) {
            adminActivityChanges[`Item_${change.orderItemId}_Count`] = {
              from: item.Count,
              to: change.newCount,
            };
          }
        });
      }

      // Log admin activity
      try {
        const ip = getClientIp(ctx);
        const userAgent = getUserAgent(ctx);

        await logAdminOrderEdit(
          strapi,
          orderIdNum,
          adminActivityChanges,
          fullUser.id,
          reason,
          ip,
          userAgent,
          roleName,
        );
      } catch (activityError) {
        strapi.log.error("Failed to log admin activity for order edit", {
          orderId: orderIdNum,
          error: (activityError as Error).message,
        });
      }

      return {
        data: {
          success: true,
          refundToman,
          status: allRemoved ? "cancelled" : "adjusted",
        },
      };
    });

    // Fire-and-forget, after the refund transaction has committed — never
    // track a refund that might still roll back (see matomo-tracker.ts).
    if (refundToman > 0 && refundTransactionId) {
      void trackRefundToMatomo(strapi as any, {
        orderId: orderIdNum,
        contractTransactionId: refundTransactionId,
        amountToman: refundToman,
        userId: order.user?.id ?? order.user ?? null,
      }).catch(() => {});
    }

    return result;
  } catch (error: any) {
    strapi.log.error("adminAdjustItems error", error);
    const message = String(error?.message || "");

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
