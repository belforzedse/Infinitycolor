import type { Strapi } from "@strapi/strapi";
import { decrementStockAtomic } from "../../../cart/services/lib/stock";
import { logManualActivity } from "../../../../utils/manualAdminActivity";
import { requireCapability } from "../../../../utils/adminAuthorization";

class ManualStockIntegrityError extends Error {
  constructor(
    readonly code:
      | "ORDER_NOT_FOUND"
      | "NOT_MANUAL_ORDER"
      | "MANUAL_ORDER_HAS_NO_ITEMS"
      | "MANUAL_STOCK_INVALID_ITEM"
      | "MANUAL_STOCK_DECREMENT_FAILED",
    message: string,
    readonly status: 404 | 409 | 422,
  ) {
    super(message);
    this.name = "ManualStockIntegrityError";
  }
}

/** Apply every manual-order stock decrement once, in one database transaction. */
export async function decrementManualOrderStockHandler(strapi: Strapi, ctx: any) {
  const orderId = Number(ctx.params?.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    ctx.status = 400;
    ctx.body = {
      data: { success: false, errorCode: "INVALID_ORDER_ID", error: "Invalid order ID" },
    };
    return;
  }

  try {
    const actor = await requireCapability(ctx, strapi, "order.manual.create");
    if (!actor) return;
    const fullUser = actor.user;
    const roleName = fullUser?.role?.name;

    const applied = await strapi.db.transaction(async ({ trx }) => {
      const locked = await trx.raw(
        "SELECT id FROM orders WHERE id = ? FOR UPDATE",
        [orderId],
      );
      if ((locked?.rows || []).length === 0) {
        throw new ManualStockIntegrityError(
          "ORDER_NOT_FOUND",
          "Order not found",
          404,
        );
      }

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
        throw new ManualStockIntegrityError(
          "ORDER_NOT_FOUND",
          "Order not found",
          404,
        );
      }
      if (order.Type !== "Manual") {
        throw new ManualStockIntegrityError(
          "NOT_MANUAL_ORDER",
          "This endpoint is only for manual orders",
          422,
        );
      }
      if (order.ManualStockAppliedAt) {
        return { alreadyApplied: true as const, results: [] as any[] };
      }

      const items = Array.isArray(order.order_items) ? order.order_items : [];
      if (items.length === 0) {
        throw new ManualStockIntegrityError(
          "MANUAL_ORDER_HAS_NO_ITEMS",
          "Manual order has no items",
          422,
        );
      }

      const validated = items.map((item: any) => {
        const stockId = Number(item?.product_variation?.product_stock?.id);
        const quantity = Number(item?.Count);
        if (!Number.isInteger(stockId) || stockId <= 0 || !Number.isInteger(quantity) || quantity <= 0) {
          throw new ManualStockIntegrityError(
            "MANUAL_STOCK_INVALID_ITEM",
            `Order item ${Number(item?.id) || "unknown"} has invalid stock data`,
            422,
          );
        }
        return {
          orderItemId: Number(item.id),
          variationId: Number(item?.product_variation?.id),
          stockId,
          quantity,
        };
      });

      const results: any[] = [];
      for (const item of validated) {
        const decremented = await decrementStockAtomic(
          strapi,
          item.stockId,
          item.quantity,
          trx,
        );
        if (!decremented.success || decremented.newCount == null) {
          throw new ManualStockIntegrityError(
            "MANUAL_STOCK_DECREMENT_FAILED",
            decremented.error || `Failed to decrement stock ${item.stockId}`,
            409,
          );
        }
        results.push({
          ...item,
          newCount: Number(decremented.newCount),
        });
      }

      await strapi.db.query("api::order.order").update({
        where: { id: orderId },
        data: { ManualStockAppliedAt: new Date() },
        transacting: trx,
      } as any);

      return { alreadyApplied: false as const, results };
    });

    if (!applied.alreadyApplied) {
      try {
        const changes: Record<string, { from?: number; to?: number }> = {};
        for (const result of applied.results) {
          changes[`Stock_${result.stockId}_Count`] = {
            from: result.newCount + result.quantity,
            to: result.newCount,
          };
        }
        await logManualActivity(strapi, {
          resourceType: "Stock",
          resourceId: orderId,
          action: "Adjust",
          title: "کاهش موجودی دستی",
          message: `کاهش موجودی برای سفارش دستی #${orderId}`,
          messageEn: `Stock decremented for manual order #${orderId}`,
          severity: "info",
          changes,
          metadata: {
            orderId,
            itemsProcessed: applied.results.length,
            stockResults: applied.results,
          },
          performedBy: { id: fullUser.id, role: roleName },
          ip: ctx.request?.ip || ctx.ip || null,
          userAgent:
            ctx.request?.headers?.["user-agent"] ||
            ctx.headers?.["user-agent"] ||
            null,
        });
      } catch (activityError) {
        strapi.log.error("Failed to log manual stock activity", {
          orderId,
          error: (activityError as Error).message,
        });
      }
    }

    ctx.status = 200;
    ctx.body = {
      data: applied.alreadyApplied
        ? { success: true, alreadyApplied: true }
        : { success: true, applied: true, results: applied.results },
    };
  } catch (error) {
    if (error instanceof ManualStockIntegrityError) {
      ctx.status = error.status;
      ctx.body = {
        data: { success: false, errorCode: error.code, error: error.message },
      };
      return;
    }
    strapi.log.error("Failed to decrement stock for manual order", {
      orderId,
      error: error instanceof Error ? error.message : String(error),
    });
    ctx.status = 500;
    ctx.body = {
      data: {
        success: false,
        errorCode: "MANUAL_STOCK_INTERNAL_ERROR",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
