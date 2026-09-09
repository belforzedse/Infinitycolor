import type { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";
import {
  hasPaidMember,
  RESERVE_GROUP_STATES,
  UID as RESERVE_GROUP_UID,
} from "../../../reserve-group/lib/reserve-group";

/** Context shape for getActiveReserve: state and methods used by the handler. */
export type GetActiveReserveContext = {
  state: { user?: { id: number } };
  unauthorized: (message?: string) => never;
  body?: object;
};

export type ActiveReservePayload = {
  reserveGroupId: string;
  reserveExpiresAt: string | null;
  orders: unknown[];
  orderCount: number;
  shippingCostPaid: number;
  shippingMethodTitle: string | null;
  deliveryAddress: unknown;
  lastOrderAttachedAt: string | null;
  rootOrderId: number | null;
};

/**
 * The customer's single attachable reserve group, or null.
 *
 * "Attachable" means: Active, deadline still ahead, and anchored on an order that
 * was really paid for. An unpaid or cancelled root deliberately yields null -- the
 * old behaviour accepted `Status: "Paying"` here, so an abandoned checkout kept
 * offering a window that could never ship.
 *
 * Only one open group can exist per customer (enforced at finalize and by a
 * partial unique index), so this is a single-row lookup rather than a
 * most-recent-wins pick that would quietly mask a broken invariant.
 */
export async function getActiveReserveHandler(
  strapi: Strapi,
  ctx: GetActiveReserveContext,
): Promise<
  | { data: null; error?: never }
  | { data: ActiveReservePayload; error?: never }
  | { data: null; error: { message: string; details?: unknown } }
> {
  const userId = await resolveCustomerTargetUserId(ctx, strapi);
  if (!userId) return { data: null };

  try {
    const now = new Date();
    const group: any = await strapi.db.query(RESERVE_GROUP_UID).findOne({
      where: {
        owner: { id: userId },
        State: RESERVE_GROUP_STATES.active,
        expiresAt: { $gt: now.toISOString() },
      },
      populate: {
        shipping: true,
        rootOrder: true,
        delivery_address: {
          populate: {
            shipping_city: { populate: { shipping_province: true } },
          },
        },
      },
    });

    if (!group?.groupKey) return { data: null };

    // A window whose orders were never paid for is not offerable.
    if (!(await hasPaidMember(strapi, group.id))) return { data: null };

    const orders = await strapi.db.query("api::order.order").findMany({
      where: { user: { id: userId }, reserve_shipment: { id: group.id } },
      populate: {
        order_items: {
          populate: {
            product_variation: {
              populate: {
                product: { populate: ["CoverImage"] },
                product_variation_color: true,
                product_variation_size: true,
                product_variation_model: true,
              },
            },
          },
        },
        shipping: true,
        delivery_address: {
          populate: {
            shipping_city: { populate: { shipping_province: true } },
          },
        },
      },
      orderBy: { Date: "asc" },
    });

    return {
      data: {
        reserveGroupId: group.groupKey,
        reserveExpiresAt: group.expiresAt ?? null,
        orders,
        orderCount: orders.length,
        shippingCostPaid: Number(group.ShippingCostPaid || 0),
        shippingMethodTitle:
          group.ShippingMethodTitle || group.shipping?.Title || null,
        deliveryAddress: group.delivery_address ?? null,
        lastOrderAttachedAt: group.lastOrderAttachedAt ?? null,
        rootOrderId: group.rootOrder?.id ?? null,
      },
    };
  } catch (err) {
    strapi.log.error("getActiveReserve failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      data: null,
      error: {
        message: "Failed to get active reserve",
        details: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
