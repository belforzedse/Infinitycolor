import type { Strapi } from "@strapi/strapi";
import { logAdminOrderCancel } from "../../../../utils/adminActivity";
import { releaseReservedStockAtomic } from "../../../cart/services/lib/stock";
import { requireCapability } from "../../../../utils/adminAuthorization";
import { queueSnappayAdminCancel } from "../../../payment-gateway/services/snappay-orchestrator";
import { isSnappayGatewayValue } from "../../../payment-gateway/services/checkout-gateway-availability";
import { computePaidAmountToman } from "./paidAmount";
import { enqueueRefundForReturn } from "../../../report/analytics/outbox";

export async function adminCancelOrderHandler(strapi: Strapi, ctx: any) {
  const { id } = ctx.params;
  const orderIdNum = Number(id);
  if (!Number.isFinite(orderIdNum)) {
    return ctx.badRequest("Invalid order id");
  }
  const { reason } = ctx.request.body as { reason?: string };

  try {
    const actor = await requireCapability(ctx, strapi, "order.cancel");
    if (!actor) return;
    const fullUser = actor.user;
    const roleName = fullUser?.role?.name;

    // Load order
    const order = await strapi.db.query("api::order.order").findOne({
      where: { id: orderIdNum },
      populate: {
        order_items: {
          populate: {
            product_variation: {
              populate: {
                product_stock: true,
              },
            },
          },
        },
        contract: {
          populate: {
            contract_transactions: true,
          },
        },
      },
    });

    if (!order) {
      return ctx.notFound("Order not found");
    }

    // Preconditions
    if (!["Paying", "Started"].includes(order.Status)) {
      return ctx.badRequest("Order status does not allow cancellation", {
        data: { error: "invalid_status" },
      });
    }

    if (order.ShippingBarcode) {
      return ctx.conflict("Shipping barcode exists; void it first", {
        data: { error: "barcode_exists" },
      });
    }

    const contract = order.contract;
    const contractIdNum = Number(contract?.id);
    const paidAmount = computePaidAmountToman(order);
    const txList = contract?.contract_transactions || [];
    const isSnappay =
      isSnappayGatewayValue(order.PaymentGateway) ||
      isSnappayGatewayValue(contract?.external_source) ||
      txList.some((tx: any) => isSnappayGatewayValue(tx?.external_source));

    if (isSnappay) {
      const normalizedReason = String(reason || "").trim();
      if (normalizedReason.length < 3) {
        return ctx.badRequest("Cancellation reason is required", {
          data: { error: "SNAPPAY_OPERATOR_REASON_REQUIRED" },
        });
      }
      const operation: any = await queueSnappayAdminCancel(strapi, {
        orderId: orderIdNum,
        reason: normalizedReason,
        actorId: Number(fullUser.id),
        requestKey: String(ctx.request?.headers?.["x-idempotency-key"] || ""),
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

    // Non-SnappPay cancellations remain an atomic local wallet operation.
    let refundTransactionId: number | null = null;
    const result = await strapi.db.transaction(async () => {
      let reservationReleased = false;
      // Restock all items
      for (const item of order.order_items) {
        const stockId = item.product_variation?.product_stock?.id;
        if (stockId) {
          const qty = Number(item.Count || 0);
          if (order.Status === "Started") {
            const stock = await strapi.db
              .query("api::product-stock.product-stock")
              .findOne({ where: { id: stockId } });
            if (stock) {
              await strapi.db.query("api::product-stock.product-stock").update({
                where: { id: stockId },
                data: {
                  Count: Number(stock.Count || 0) + qty,
                },
              });
            }
          } else if (order.Status === "Paying") {
            // For unpaid orders, only release reservation (do NOT increment Count)
            if (order.ReservationStatus === "Reserved") {
              const releaseResult = await releaseReservedStockAtomic(
                strapi as any,
                Number(stockId),
                qty,
              );
              if (!releaseResult.success) {
                strapi.log.error("Failed to release reserved stock during admin cancel", {
                  orderId: orderIdNum,
                  stockId,
                  qty,
                  error: releaseResult.error,
                });
                throw new Error(releaseResult.error || "RELEASE_RESERVED_STOCK_FAILED");
              }
              reservationReleased = true;
            }
          }
        }
      }

      // Update order and contract
      const orderUpdateData: Record<string, unknown> = { Status: "Cancelled" };
      if (reservationReleased) {
        orderUpdateData.ReservationStatus = "Released";
      }
      await strapi.db.query("api::order.order").update({
        where: { id: orderIdNum },
        data: orderUpdateData,
      });

      if (Number.isFinite(contractIdNum)) {
        await strapi.db.query("api::contract.contract").update({
          where: { id: contractIdNum },
          data: { Status: "Cancelled", Amount: 0 },
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

        if (paidAmount > 0) {
          const refundIrr = paidAmount * 10;
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
                Cause: "Order Cancelled (Admin)",
                ReferenceId: `order-${orderIdNum}-cancel-${Date.now()}`,
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
      }

      // Log
      await strapi.db.query("api::order-log.order-log").create({
        data: {
          order: orderIdNum,
          Action: "Update",
          Description: "Admin cancelled order",
          Changes: {
            reason: reason || "",
            refundToman: paidAmount,
          },
          PerformedBy: `Admin User ${fullUser.id}`,
        },
      });

      // Log admin activity
      try {
        const ip = ctx.request?.ip || ctx.ip || null;
        const userAgent =
          ctx.request?.headers?.["user-agent"] || ctx.headers?.["user-agent"] || null;

        await logAdminOrderCancel(
          strapi,
          orderIdNum,
          reason || "بدون دلیل",
          fullUser.id,
          ip,
          userAgent,
          roleName,
        );
      } catch (activityError) {
        strapi.log.error("Failed to log admin activity for order cancel", {
          orderId: orderIdNum,
          error: (activityError as Error).message,
        });
      }

      return {
        data: {
          success: true,
          refundToman: paidAmount,
          status: "cancelled",
        },
      };
    });

    // Enqueue only after the refund transaction commits. Delivery is retried by
    // the analytics worker and can never block the cancellation response.
    if (paidAmount > 0 && refundTransactionId) {
      void enqueueRefundForReturn(strapi as any, {
        orderId: orderIdNum,
        contractTransactionId: refundTransactionId,
        amountToman: paidAmount,
      }).catch(() => {});
    }

    return result;
  } catch (error: any) {
    strapi.log.error("adminCancelOrder error", error);
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
    return ctx.internalServerError("Failed to cancel order", {
      data: { error: error.message },
    });
  }
}
