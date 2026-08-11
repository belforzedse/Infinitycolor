import type { Strapi } from "@strapi/strapi";
import { logAdminOrderCancel } from "../../../../utils/adminActivity";
import { releaseReservedStockAtomic } from "../../../cart/services/lib/stock";
import { releaseOrderDiscountClaim } from "../../../cart/services/lib/discount-claim";
import { requireCapability } from "../../../../utils/adminAuthorization";
import { queueSnappayAdminCancel } from "../../../payment-gateway/services/snappay-orchestrator";
import { isSnappayGatewayValue } from "../../../payment-gateway/services/checkout-gateway-availability";
import { computePaidAmountToman } from "./paidAmount";
import { enqueueRefundForReturn } from "../../../report/analytics/outbox";
import {
  creditOrderRefund,
  lockOrderForAdminMutation,
  OrderChangedConcurrentlyError,
  restoreStockWithMandatoryAudit,
} from "./adminOrderIntegrity";

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
        // The refund block below resolves the customer's wallet from `order.user`.
        // Without this populate that is always undefined, and the wallet lookup fails
        // with an undefined-binding error that aborts the whole cancellation.
        user: true,
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
              product_variation: { populate: { product_stock: true } },
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

      const paidAmount = computePaidAmountToman(currentOrder);
      committedRefundToman = paidAmount;
      let reservationReleased = false;
      // Restock all items
      for (const item of currentOrder.order_items || []) {
        const stockId = item.product_variation?.product_stock?.id;
        if (stockId) {
          const qty = Number(item.Count || 0);
          if (!Number.isInteger(qty) || qty <= 0) continue;
          if (currentOrder.Status === "Started") {
            await restoreStockWithMandatoryAudit(strapi, {
              stockId: Number(stockId),
              quantity: qty,
              orderId: orderIdNum,
              cause: "Admin Order Cancellation",
              trx,
            });
          } else if (currentOrder.Status === "Paying") {
            // For unpaid orders, only release reservation (do NOT increment Count)
            if (currentOrder.ReservationStatus === "Reserved") {
              // `trx` is mandatory here: releaseReservedStockAtomic issues raw SQL,
              // and raw SQL does not inherit the ambient transaction the way
              // strapi.db.query does. Without it the reserved_count decrement
              // commits immediately and survives a rollback of this cancellation.
              const releaseResult = await releaseReservedStockAtomic(
                strapi as any,
                Number(stockId),
                qty,
                trx,
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

      // This path releases reserved stock directly instead of going through
      // releaseOrderReservation, so it has to hand the coupon usage back itself.
      // Only the `Paying` branch can actually release: the helper refuses once the
      // order has reached a settled status, and cancelling a `Started` order means the
      // customer did pay, so its usage stays consumed. Runs before the status write
      // regardless, so the guard reads the pre-cancellation status.
      await releaseOrderDiscountClaim(strapi as any, orderIdNum, trx);

      // Update order and contract
      const orderUpdateData: Record<string, unknown> = { Status: "Cancelled" };
      if (reservationReleased) {
        orderUpdateData.ReservationStatus = "Released";
      }
      await strapi.db.query("api::order.order").update({
        where: { id: orderIdNum },
        data: orderUpdateData,
        transacting: trx,
      } as any);

      if (Number.isFinite(currentContractId)) {
        await strapi.db.query("api::contract.contract").update({
          where: { id: currentContractId },
          data: { Status: "Cancelled", Amount: 0 },
          transacting: trx,
        } as any);
      }

      // Refund to wallet. SnappPay orders returned above and never reach here.
      const userId = Number(currentOrder.user?.id || currentOrder.user);
      if (paidAmount > 0 && !Number.isFinite(userId)) {
        throw new Error("ORDER_REFUND_USER_NOT_FOUND");
      }
      refundTransactionId = await creditOrderRefund(strapi, {
        userId,
        orderId: orderIdNum,
        contractId: Number.isFinite(currentContractId) ? currentContractId : null,
        transactions: currentTransactions,
        refundToman: paidAmount,
        kind: "cancel",
        note: String(reason || "") || undefined,
        trx,
      });

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
        transacting: trx,
      } as any);

      await logAdminOrderCancel(
        strapi,
        orderIdNum,
        reason || "بدون دلیل",
        fullUser.id,
        ctx.request?.ip || ctx.ip || null,
        ctx.request?.headers?.["user-agent"] || ctx.headers?.["user-agent"] || null,
        roleName,
        trx,
      );

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
    if (committedRefundToman > 0 && refundTransactionId) {
      void enqueueRefundForReturn(strapi as any, {
        orderId: orderIdNum,
        contractTransactionId: refundTransactionId,
        amountToman: committedRefundToman,
      }).catch(() => {});
    }

    return result;
  } catch (error: any) {
    strapi.log.error("adminCancelOrder error", error);
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
    return ctx.internalServerError("Failed to cancel order", {
      data: { error: error.message },
    });
  }
}
