import type { Strapi } from "@strapi/strapi";
import { logAdminOrderFieldUpdate } from "../../../../utils/adminActivity";
import { getClientIp, getUserAgent } from "../../../../utils/getClientIp";
import { OPERATIONAL_ROLES, roleIsAllowed } from "../../../../utils/roles";
import { notifyOrderStatusSms } from "../../../../services/sms/notifications";

const NEXT_STATUS: Record<string, string[]> = {
  Started: ["Shipment"],
  Shipment: ["Done"],
};

export async function adminTransitionOrderHandler(strapi: Strapi, ctx: any) {
  const orderId = Number(ctx.params?.id);
  const nextStatus = String(ctx.request?.body?.status || "").trim();
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return ctx.badRequest("Invalid order id");
  }

  const actor = ctx.state?.user;
  const fullUser = actor?.id
    ? await strapi.db.query("plugin::users-permissions.user").findOne({
        where: { id: actor.id },
        populate: ["role"],
      })
    : null;
  if (!fullUser || !roleIsAllowed(fullUser.role?.name, OPERATIONAL_ROLES)) {
    return ctx.forbidden("Admin access required");
  }

  const order: any = await strapi.db.query("api::order.order").findOne({
    where: { id: orderId },
    select: ["id", "Status", "ShippingBarcode", "PaymentGateway"],
    populate: { user: { select: ["id"] } },
  });
  if (!order) return ctx.notFound("Order not found");
  if (order.PaymentGateway === "SnappPay") {
    return ctx.conflict("Use the established SnappPay order update flow", {
      data: {
        success: false,
        errorCode: "SNAPPAY_LEGACY_FLOW_REQUIRED",
      },
    });
  }
  if (order.Status === nextStatus) {
    return { data: { success: true, orderId, status: nextStatus, unchanged: true } };
  }
  if (!(NEXT_STATUS[order.Status] || []).includes(nextStatus)) {
    return ctx.conflict("Order status transition is not allowed", {
      data: {
        success: false,
        errorCode: "INVALID_ORDER_TRANSITION",
        fromStatus: order.Status,
        requestedStatus: nextStatus,
        allowedStatuses: NEXT_STATUS[order.Status] || [],
      },
    });
  }

  await strapi.db.transaction(async ({ trx }) => {
    const update = await trx.raw(
      `UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ? AND status = ? RETURNING id`,
      [nextStatus, orderId, order.Status],
    );
    if (!(update.rows || []).length) {
      throw new Error("ORDER_STATUS_CHANGED_CONCURRENTLY");
    }
    await strapi.db.query("api::order-log.order-log").create({
      data: {
        order: orderId,
        Action: "Update",
        Description: "Admin changed order lifecycle status",
        Changes: { fromStatus: order.Status, toStatus: nextStatus },
        performed_by: Number(fullUser.id),
      },
      transacting: trx,
    } as any);
  });

  await logAdminOrderFieldUpdate(
    strapi,
    orderId,
    { Status: { from: order.Status, to: nextStatus } },
    Number(fullUser.id),
    getClientIp(ctx),
    getUserAgent(ctx),
  );

  const customerId = Number(order.user?.id ?? order.user);
  if (Number.isFinite(customerId) && customerId > 0) {
    try {
      const activityService = strapi.service("api::user-activity.user-activity") as any;
      if (nextStatus === "Shipment") {
        await activityService?.logOrderShipped?.(
          customerId,
          orderId,
          order.ShippingBarcode || undefined,
        );
      } else if (nextStatus === "Done") {
        await activityService?.logOrderDelivered?.(customerId, orderId);
      }
    } catch (error) {
      strapi.log.error("Failed to log customer order-transition activity", {
        orderId,
        customerId,
        newStatus: nextStatus,
        error: (error as Error)?.message || error,
      });
    }
  }

  // This transition uses a conditional raw update for concurrency safety, so it
  // does not pass through Strapi's entity lifecycle that normally queues the
  // customer status notification.
  void notifyOrderStatusSms(strapi as any, {
    orderId,
    oldStatus: order.Status,
    newStatus: nextStatus,
  }).catch((error) => {
    strapi.log.error("Failed to queue admin order-transition SMS", {
      orderId,
      oldStatus: order.Status,
      newStatus: nextStatus,
      error: (error as Error)?.message || error,
    });
  });

  return { data: { success: true, orderId, status: nextStatus } };
}
