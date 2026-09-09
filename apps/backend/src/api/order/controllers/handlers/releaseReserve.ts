// @ts-nocheck
import type { Attribute } from "@strapi/types";
import type { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";
import {
  auditCustomerReserveEvent,
  closeGroup,
  lockReserveGroup,
  RESERVE_CLOSURE_REASONS,
  RESERVE_GROUP_STATES,
  UID as RESERVE_GROUP_UID,
} from "../../../reserve-group/lib/reserve-group";

/** Context shape for releaseReserve: state and methods used by the handler. */
type ReleaseReserveContext = {
  params: { id: string };
  state: { user: { id: number } | undefined };
  badRequest: (msg: string, opts?: object) => void;
  unauthorized: (msg?: string, opts?: object) => void;
};

/**
 * "Send my orders now" -- the customer voluntarily ends the window early.
 *
 * Closes the group as ReleasedEarly, which stays distinguishable from an
 * automatic Expired forever. Nothing on the member orders is rewritten; the group
 * row carries the outcome.
 */
export async function releaseReserveHandler(
  strapi: Strapi,
  ctx: ReleaseReserveContext
) {
  const { id } = ctx.params;
  const { user } = ctx.state;

  if (!user?.id) {
    return ctx.unauthorized("Authentication required", {
      data: { success: false, errorCode: "UNAUTHORIZED" },
    });
  }

  const userId = await resolveCustomerTargetUserId(ctx, strapi);
  if (!userId) return;

  const orderId = Number(id);
  if (Number.isNaN(orderId)) {
    return ctx.badRequest("Invalid order id", {
      data: { success: false, errorCode: "INVALID_ID" },
    });
  }

  const order = await strapi.db.query("api::order.order").findOne({
    where: { id: orderId, user: { id: userId } },
    populate: { reserve_shipment: true },
  });

  if (!order) {
    return ctx.badRequest("Order not found", {
      data: { success: false, errorCode: "ORDER_NOT_FOUND" },
    });
  }

  const group = order.reserve_shipment;
  if (!group?.id) {
    return ctx.badRequest("This order is not a reserve order", {
      data: { success: false, errorCode: "NOT_RESERVE_ORDER" },
    });
  }

  let released = false;
  let orderCount = 0;

  await strapi.db.transaction(async ({ trx }) => {
    await lockReserveGroup(strapi, group.id, trx);

    const fresh = await strapi.db.query(RESERVE_GROUP_UID).findOne({
      where: { id: group.id },
      transacting: trx,
    });

    if (!fresh || fresh.State !== RESERVE_GROUP_STATES.active) {
      return;
    }

    released = await closeGroup(
      strapi,
      {
        groupId: group.id,
        reason: RESERVE_CLOSURE_REASONS.releasedEarly,
      },
      trx
    );
    if (!released) return;

    const groupOrders = await strapi.db.query("api::order.order").findMany({
      where: { user: { id: userId }, reserve_shipment: { id: group.id } },
      transacting: trx,
    });
    orderCount = groupOrders.length;

    // Per-order changelog stays: operators read order history per order.
    for (const o of groupOrders) {
      try {
        await strapi.db.query("api::order-log.order-log").create({
          data: {
            order: o.id,
            performed_by: user.id,
            Action: "Update",
            Description: "Reserve released early by customer; group ready to ship",
            PerformedBy: `User ${user.id}`,
            Changes: {
              reserveGroupId: group.groupKey,
              previous: { state: RESERVE_GROUP_STATES.active },
              new: {
                state: RESERVE_GROUP_STATES.readyToFulfill,
                closureReason: RESERVE_CLOSURE_REASONS.releasedEarly,
              },
            } as unknown as Attribute.JsonValue,
          },
          transacting: trx,
        });
      } catch (logErr) {
        strapi.log.error("Failed to create order-log for release_reserve", {
          orderId: o.id,
          reserveGroupId: group.groupKey,
          error: logErr,
        });
      }
    }
  });

  if (!released) {
    return ctx.badRequest("Reserve window is no longer active", {
      data: { success: false, errorCode: "RESERVE_EXPIRED" },
    });
  }

  await auditCustomerReserveEvent(strapi, {
    eventKey: "orders.reserve_released_early",
    userId,
    group: { id: group.id, groupKey: group.groupKey },
    changes: [
      { field: "state", label: "وضعیت", from: "Active", to: "ReadyToFulfill" },
      { field: "closureReason", label: "دلیل پایان", from: null, to: "ReleasedEarly" },
    ],
    metadata: { triggeredByOrderId: orderId, orderCount },
  });

  strapi.log.info("Reserve released early", {
    orderId,
    userId,
    reserveGroupId: group.groupKey,
    action: "release_reserve",
    orderCount,
  });

  return {
    data: {
      success: true,
      message: "Reserve released. Your order is now being prepared for shipping.",
      orderCount,
    },
  };
}
