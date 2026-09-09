import type { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../../utils/roles";
import {
  countGroupOrders,
  RESERVE_GROUP_STATES,
  UID as RESERVE_GROUP_UID,
} from "../../../reserve-group/lib/reserve-group";

type ListContext = {
  state: { user?: { id: number } };
  query?: Record<string, unknown>;
  unauthorized: (message?: string) => unknown;
  notFound: (message?: string, opts?: object) => unknown;
  params?: { groupKey?: string };
};

export type CustomerReserveGroup = {
  reserveGroupId: string;
  state: string;
  closureReason: string | null;
  expiresAt: string | null;
  activatedAt: string | null;
  closedAt: string | null;
  lastOrderAttachedAt: string | null;
  lastActivityAt: string | null;
  orderCount: number;
  shippingCostPaid: number;
  shippingMethodTitle: string | null;
  destination: string | null;
  rootOrderId: number | null;
  shippingBarcode: string | null;
  isActive: boolean;
};

/**
 * A group's address rendered the way the storefront address picker renders one,
 * so the shopper recognises the destination without a second lookup.
 */
function formatDestination(address: any): string | null {
  if (!address) return null;
  const city = address.shipping_city?.Title?.trim?.() || null;
  const province = address.shipping_city?.shipping_province?.Title?.trim?.() || null;
  const full = address.FullAddress?.trim?.() || null;
  const place = [city, province].filter(Boolean).join("، ");
  if (full && place) return `${full} - ${place}`;
  return full || place || null;
}

const GROUP_POPULATE = {
  shipping: true,
  rootOrder: true,
  delivery_address: {
    populate: { shipping_city: { populate: { shipping_province: true } } },
  },
} as const;

async function project(strapi: Strapi, group: any): Promise<CustomerReserveGroup> {
  const expiresAt = group.expiresAt ?? null;
  return {
    reserveGroupId: group.groupKey,
    state: String(group.State || ""),
    closureReason: group.ClosureReason ?? null,
    expiresAt,
    activatedAt: group.activatedAt ?? null,
    closedAt: group.closedAt ?? null,
    lastOrderAttachedAt: group.lastOrderAttachedAt ?? null,
    lastActivityAt: group.lastActivityAt ?? null,
    orderCount: await countGroupOrders(strapi, group.id),
    shippingCostPaid: Number(group.ShippingCostPaid || 0),
    shippingMethodTitle: group.ShippingMethodTitle || group.shipping?.Title || null,
    destination: formatDestination(group.delivery_address),
    rootOrderId: group.rootOrder?.id ?? null,
    shippingBarcode: group.ShippingBarcode ?? null,
    isActive:
      String(group.State) === RESERVE_GROUP_STATES.active &&
      expiresAt != null &&
      new Date(expiresAt).getTime() > Date.now(),
  };
}

/**
 * Every reserve group the customer has ever had, newest first.
 *
 * Closed groups are deliberately included: a shipment that already went out is
 * still the record of why several orders travelled together, and dropping it
 * would make the history unreadable. `PendingActivation` groups are excluded --
 * they represent an unpaid checkout and have no shipment behind them yet.
 */
export async function listMyReserveGroupsHandler(strapi: Strapi, ctx: ListContext) {
  const userId = await resolveCustomerTargetUserId(ctx as any, strapi);
  if (!userId) return { data: [] };

  const page = Math.max(1, Number(ctx.query?.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(ctx.query?.pageSize ?? 20) || 20));

  const where = {
    owner: { id: userId },
    State: { $ne: RESERVE_GROUP_STATES.pendingActivation },
  };

  const [rows, total] = await Promise.all([
    strapi.db.query(RESERVE_GROUP_UID).findMany({
      where,
      populate: GROUP_POPULATE,
      orderBy: { lastActivityAt: "desc" },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    strapi.db.query(RESERVE_GROUP_UID).count({ where }),
  ]);

  const data = await Promise.all(
    (rows as any[]).map((group) => project(strapi, group)),
  );

  return {
    data,
    meta: {
      pagination: {
        page,
        pageSize,
        pageCount: Math.max(1, Math.ceil(total / pageSize)),
        total,
      },
    },
  };
}

/** One group, scoped to its owner. Member orders are fetched separately. */
export async function getMyReserveGroupHandler(strapi: Strapi, ctx: ListContext) {
  const userId = await resolveCustomerTargetUserId(ctx as any, strapi);
  if (!userId) return { data: null };

  const groupKey = String(ctx.params?.groupKey || "").trim();
  if (!groupKey) return ctx.notFound("Reserve group not found");

  const group: any = await strapi.db.query(RESERVE_GROUP_UID).findOne({
    where: { groupKey, owner: { id: userId } },
    populate: GROUP_POPULATE,
  });

  if (!group?.id) return ctx.notFound("Reserve group not found");

  return { data: await project(strapi, group) };
}
