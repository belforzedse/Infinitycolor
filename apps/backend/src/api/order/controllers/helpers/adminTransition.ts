import type { Strapi } from "@strapi/strapi";
import { logAdminOrderFieldUpdate } from "../../../../utils/adminActivity";
import { getClientIp, getUserAgent } from "../../../../utils/getClientIp";
import { requireCapability } from "../../../../utils/adminAuthorization";
import { notifyOrderStatusSms } from "../../../../services/sms/notifications";
import { isOrderHeldByReserve } from "../../../reserve-group/lib/reserve-group";
import { enqueueAnipoRegistration } from "../../../../queue/anipo-registration";
import { recordAnipoRegistrationFailure } from "../../services/anipoBarcodeWorkflow";

// Fulfilment order is «تکمیل شده» then «ارسال»: an order is prepared/completed
// first and handed to the courier second, so `Shipment` is the terminal step.
const NEXT_STATUS: Record<string, string[]> = {
  Started: ["Done"],
  Done: ["Shipment"],
};

type TransitionActor = {
  id: number;
  ip?: string | null;
  userAgent?: string | null;
  roleName?: string;
};

async function applyOrderStatusTransition(
  strapi: Strapi,
  orderId: number,
  fromStatus: string,
  statuses: string[],
  actor: TransitionActor,
  queueAnipo: boolean,
): Promise<void> {
  await strapi.db.transaction(async ({ trx }) => {
    let previous = fromStatus;
    for (const toStatus of statuses) {
      const update = await trx.raw(
        `UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ? AND status = ? RETURNING id`,
        [toStatus, orderId, previous],
      );
      if (!(update.rows || []).length) throw new Error("ORDER_STATUS_CHANGED_CONCURRENTLY");
      await strapi.db.query("api::order-log.order-log").create({
        data: {
          order: orderId,
          Action: "Update",
          Description: "Admin changed order lifecycle status",
          Changes: { fromStatus: previous, toStatus },
          performed_by: actor.id,
        },
        transacting: trx,
      } as any);
      await logAdminOrderFieldUpdate(
        strapi, orderId, { Status: { from: previous, to: toStatus } },
        actor.id, actor.ip, actor.userAgent, actor.roleName, trx,
      );
      previous = toStatus;
    }
    if (queueAnipo) {
      await trx.raw(
        `UPDATE orders SET anipo_barcode_state = 'Pending'
         WHERE id = ? AND status = 'Shipment' AND anipo_barcode_state IS NULL
           AND anipo_submitted_at IS NULL AND shipping_barcode IS NULL`,
        [orderId],
      );
    }
  });
}

async function notifyOrderTransitioned(
  strapi: Strapi,
  orderId: number,
  customerId: number | undefined,
  fromStatus: string,
  toStatus: string,
  shippingBarcode?: string | null,
): Promise<void> {
  if (Number.isFinite(customerId) && (customerId as number) > 0) {
    try {
      const activityService = strapi.service("api::user-activity.user-activity") as any;
      // `Done` means the order is prepared, not delivered, so it no longer logs a
      // delivery event. `Shipment` is the terminal step and keeps logOrderShipped.
      if (toStatus === "Shipment") {
        await activityService?.logOrderShipped?.(
          customerId,
          orderId,
          shippingBarcode || undefined,
        );
      }
    } catch (error) {
      strapi.log.error("Failed to log customer order-transition activity", {
        orderId,
        customerId,
        newStatus: toStatus,
        error: (error as Error)?.message || error,
      });
    }
  }

  // This transition uses a conditional raw update for concurrency safety, so it
  // does not pass through Strapi's entity lifecycle that normally queues the
  // customer status notification.
  void notifyOrderStatusSms(strapi as any, {
    orderId,
    oldStatus: fromStatus,
    newStatus: toStatus,
  }).catch((error) => {
    strapi.log.error("Failed to queue admin order-transition SMS", {
      orderId,
      oldStatus: fromStatus,
      newStatus: toStatus,
      error: (error as Error)?.message || error,
    });
  });
}

export async function adminTransitionOrderHandler(strapi: Strapi, ctx: any) {
  const orderId = Number(ctx.params?.id);
  const nextStatus = String(ctx.request?.body?.status || "").trim();
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return ctx.badRequest("Invalid order id");
  }

  const actor = await requireCapability(ctx, strapi, "order.status.update");
  if (!actor) return;
  const fullUser = actor.user;

  const order: any = await strapi.db.query("api::order.order").findOne({
    where: { id: orderId },
    select: ["id", "Status", "ShippingBarcode", "ShippingMethodCode", "AnipoBarcodeState", "AnipoSubmittedAt", "PaymentGateway"],
    populate: { user: { select: ["id"] }, shipping: { select: ["Code"] } },
  });
  if (!order) return ctx.notFound("Order not found");
  if (order.Status === nextStatus) {
    return { data: { success: true, orderId, status: nextStatus, unchanged: true } };
  }
  // An order inside a live 48h combined-shipping window must not enter the
  // shipping workflow, whatever the admin clicked. Enforced here rather than only
  // by disabling a button, because bulk actions hit this same endpoint.
  if (nextStatus === "Done" || nextStatus === "Shipment") {
    const { held, group } = await isOrderHeldByReserve(strapi, orderId);
    if (held) {
      return ctx.conflict("سفارش در مهلت رزرو ۴۸ ساعته است و هنوز قابل تکمیل و ارسال نیست", {
        data: {
          success: false,
          errorCode: "RESERVE_HOLD_ACTIVE",
          reserveGroupId: group?.groupKey ?? null,
          reserveExpiresAt: group?.expiresAt ?? null,
          message: "سفارش در مهلت رزرو ۴۸ ساعته است و هنوز قابل تکمیل و ارسال نیست",
        },
      });
    }
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

  const actorInfo: TransitionActor = {
    id: Number(fullUser.id),
    ip: getClientIp(ctx),
    userAgent: getUserAgent(ctx),
    roleName: fullUser?.role?.name,
  };
  const customerId = Number(order.user?.id ?? order.user);

  const statuses = nextStatus === "Done" ? ["Done", "Shipment"] : [nextStatus];
  const finalStatus = statuses[statuses.length - 1];
  const postal = String(order.ShippingMethodCode || order.shipping?.Code || "").toLowerCase() === "post";
  const queueAnipo = finalStatus === "Shipment" && postal && !order.ShippingBarcode &&
    !order.AnipoSubmittedAt && (!order.AnipoBarcodeState || order.AnipoBarcodeState === "Pending");
  await applyOrderStatusTransition(strapi, orderId, order.Status, statuses, actorInfo, queueAnipo);
  await notifyOrderTransitioned(
    strapi,
    orderId,
    customerId,
    order.Status,
    finalStatus,
    order.ShippingBarcode,
  );

  if (queueAnipo) {
    try {
      await enqueueAnipoRegistration(orderId);
    } catch (error) {
      // The persisted Pending/unsubmitted marker is picked up by the existing
      // Anipo reconciliation scheduler when queue connectivity returns.
      strapi.log.error("Anipo registration enqueue failed", {
        orderId,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await recordAnipoRegistrationFailure(strapi, orderId, error, false);
      } catch (recordError) {
        strapi.log.error("Anipo enqueue failure state update failed", {
          orderId,
          error: recordError instanceof Error ? recordError.message : String(recordError),
        });
      }
    }
  }
  return { data: { success: true, orderId, status: finalStatus } };
}
