import type { Strapi } from "@strapi/strapi";
import { writeAuditEvent } from "../../../audit/writer";
import { runRawSql } from "../../../utils/transactionExecutor";

/**
 * The 48h combined-shipping hold.
 *
 * This is NOT the stock reservation system (`ReservationStatus`/`ReservedUntil`,
 * see docs/stock-reservation.md). That one holds inventory for ~30 minutes while a
 * shopper pays. This one holds *fulfillment* of already-paid orders for 48 hours so
 * later purchases can ride along in the same parcel and pay shipping once.
 *
 * The group row is the lock target and the idempotency anchor, exactly as
 * `reservation_status = 'Reserved'` is for the stock system.
 */

export const RESERVE_GROUP_STATES = {
  pendingActivation: "PendingActivation",
  active: "Active",
  readyToFulfill: "ReadyToFulfill",
  fulfilling: "Fulfilling",
  completed: "Completed",
  cancelled: "Cancelled",
} as const;

export type ReserveGroupState =
  (typeof RESERVE_GROUP_STATES)[keyof typeof RESERVE_GROUP_STATES];

export const RESERVE_CLOSURE_REASONS = {
  expired: "Expired",
  releasedEarly: "ReleasedEarly",
  releasedByAdmin: "ReleasedByAdmin",
  rootAbandoned: "RootAbandoned",
} as const;

export type ReserveClosureReason =
  (typeof RESERVE_CLOSURE_REASONS)[keyof typeof RESERVE_CLOSURE_REASONS];

/** States in which a group still occupies the customer's single consolidation slot. */
export const OPEN_RESERVE_STATES: ReserveGroupState[] = [
  RESERVE_GROUP_STATES.pendingActivation,
  RESERVE_GROUP_STATES.active,
];

/** States where the physical parcel has not shipped and must not be shipped yet. */
export const HELD_RESERVE_STATES: ReserveGroupState[] = [
  RESERVE_GROUP_STATES.pendingActivation,
  RESERVE_GROUP_STATES.active,
];

export const UID = "api::reserve-group.reserve-group" as const;

/**
 * Thrown when a child order is being attached to a window that closed underneath
 * it. Raised inside the order transaction so the whole attach rolls back rather
 * than leaving an orphan order bound to a dead group.
 */
export class ReserveWindowClosedError extends Error {
  readonly code = "RESERVE_WINDOW_CLOSED";

  // finalizeCartToOrder's error mapper parses "CODE: detail", so keep that shape
  // and the failure renders as a real Persian message instead of the generic
  // unmapped-error banner (which also Sentry-reports as infrastructure).
  constructor(detail = "Reserve window is no longer open") {
    super(`RESERVE_WINDOW_CLOSED: ${detail}`);
    this.name = "ReserveWindowClosedError";
  }
}

export function reserveWindowHours(): number {
  const raw = Number(process.env.RESERVE_ORDER_WINDOW_HOURS || 48);
  return Number.isFinite(raw) && raw > 0 ? raw : 48;
}

export function computeReserveDeadline(from: Date = new Date()): Date {
  return new Date(from.getTime() + reserveWindowHours() * 60 * 60 * 1000);
}

export type ReserveGroupRow = {
  id: number;
  groupKey: string;
  State: ReserveGroupState;
  ClosureReason: ReserveClosureReason | null;
  expiresAt: string | null;
  activatedAt: string | null;
  closedAt: string | null;
  lastOrderAttachedAt: string | null;
  lastActivityAt: string | null;
  ShippingCostPaid: number;
  ShippingMethodCode: string | null;
  ShippingMethodTitle: string | null;
  ShippingBarcode: string | null;
  [key: string]: unknown;
};

/**
 * Locks the group row for the duration of the surrounding transaction.
 *
 * This is what makes attach-vs-expire deterministic: the expiry job's CAS update
 * and a customer's attach cannot interleave, so exactly one of them wins and the
 * loser observes a settled state.
 */
export async function lockReserveGroup(
  strapi: Strapi,
  groupId: number,
  trx?: any,
): Promise<boolean> {
  const result = await runRawSql(
    strapi,
    "SELECT id FROM reserve_groups WHERE id = ? FOR UPDATE",
    [groupId],
    trx,
  );
  return (result?.rows || []).length > 0;
}

/** Finds the customer's open group (PendingActivation or Active), if any. */
export async function findOpenGroupForUser(
  strapi: Strapi,
  userId: number,
): Promise<ReserveGroupRow | null> {
  const group = await strapi.db.query(UID).findOne({
    where: { owner: { id: userId }, State: { $in: OPEN_RESERVE_STATES } },
  });
  return (group as ReserveGroupRow) || null;
}

/**
 * The customer's attachable group: active, not past its deadline, and anchored on
 * an order that actually got paid. The payment check is what stops a cancelled or
 * abandoned root from silently collecting free-shipping children.
 */
export async function findAttachableGroup(
  strapi: Strapi,
  userId: number,
  groupKey: string,
  now: Date = new Date(),
): Promise<ReserveGroupRow | null> {
  const group = await strapi.db.query(UID).findOne({
    where: {
      owner: { id: userId },
      groupKey,
      State: RESERVE_GROUP_STATES.active,
      expiresAt: { $gt: now.toISOString() },
    },
    populate: { rootOrder: true, delivery_address: true, shipping: true },
  });
  if (!group) return null;
  return (group as ReserveGroupRow) || null;
}

export async function countGroupOrders(
  strapi: Strapi,
  groupId: number,
): Promise<number> {
  return strapi.db.query("api::order.order").count({
    where: { reserve_shipment: { id: groupId } },
  });
}

/** True when at least one member order has been paid for. */
export async function hasPaidMember(
  strapi: Strapi,
  groupId: number,
): Promise<boolean> {
  const paid = await strapi.db.query("api::order.order").count({
    where: {
      reserve_shipment: { id: groupId },
      Status: { $in: ["Started", "Shipment", "Done"] },
    },
  });
  return paid > 0;
}

type SystemActorOptions = {
  jobId?: string;
  label?: string;
};

/** Records an automatic transition as a scheduled job, never as a human edit. */
export async function auditSystemReserveEvent(
  strapi: Strapi,
  params: {
    eventKey: string;
    group: Pick<ReserveGroupRow, "id" | "groupKey">;
    changes?: { field: string; label?: string; from?: unknown; to?: unknown }[];
    metadata?: Record<string, unknown>;
    dedupeKey?: string;
  },
  options: SystemActorOptions = {},
): Promise<void> {
  const id = options.jobId || "reserve-expiry";
  const label = options.label || "Reserve Expiry Job";
  try {
    await writeAuditEvent(strapi, {
      eventKey: params.eventKey,
      initiator: { type: "scheduled_job", id, label },
      actor: { type: "scheduled_job", id, label },
      origin: "scheduled_task",
      target: {
        type: "reserve-group",
        id: params.group.id,
        label: `Reserve group ${params.group.groupKey}`,
      },
      changes: params.changes,
      metadata: params.metadata,
      dedupeKey: params.dedupeKey,
    });
  } catch (error) {
    // Audit must never take down a lifecycle transition.
    strapi.log.error("Failed to write reserve audit event", {
      eventKey: params.eventKey,
      groupId: params.group.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Records a customer-initiated transition. Distinct from an admin action. */
export async function auditCustomerReserveEvent(
  strapi: Strapi,
  params: {
    eventKey: string;
    userId: number;
    group: Pick<ReserveGroupRow, "id" | "groupKey">;
    changes?: { field: string; label?: string; from?: unknown; to?: unknown }[];
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await writeAuditEvent(strapi, {
      eventKey: params.eventKey,
      initiator: { type: "customer", id: params.userId, label: `User ${params.userId}` },
      actor: { type: "system", id: "storefront", label: "Storefront" },
      origin: "storefront",
      target: {
        type: "reserve-group",
        id: params.group.id,
        label: `Reserve group ${params.group.groupKey}`,
      },
      changes: params.changes,
      metadata: params.metadata,
    });
  } catch (error) {
    strapi.log.error("Failed to write reserve audit event", {
      eventKey: params.eventKey,
      groupId: params.group.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Touches group-level activity without dirtying any member order row. */
export async function touchGroupActivity(
  strapi: Strapi,
  groupId: number,
  patch: Record<string, unknown> = {},
): Promise<void> {
  await strapi.db.query(UID).update({
    where: { id: groupId },
    data: { lastActivityAt: new Date(), ...patch },
  });
}

/**
 * Activates a group on first successful payment.
 *
 * The 48h clock deliberately starts here, not at checkout: gateway time belongs to
 * the customer, and an abandoned payment must never leave an attachable window.
 * CAS-guarded on PendingActivation so duplicate settlement callbacks are no-ops.
 */
export async function activateGroupOnPayment(
  strapi: Strapi,
  params: { groupId: number; orderId: number; shippingCostPaid: number; now?: Date },
  trx?: any,
): Promise<{ activated: boolean; expiresAt: Date | null }> {
  const now = params.now || new Date();
  const expiresAt = computeReserveDeadline(now);

  const result = await runRawSql(
    strapi,
    `UPDATE reserve_groups
        SET state = ?,
            activated_at = ?,
            expires_at = ?,
            last_activity_at = ?,
            shipping_cost_paid = ?,
            updated_at = NOW()
      WHERE id = ?
        AND state = ?
      RETURNING id`,
    [
      RESERVE_GROUP_STATES.active,
      now,
      expiresAt,
      now,
      Math.max(0, Math.round(Number(params.shippingCostPaid) || 0)),
      params.groupId,
      RESERVE_GROUP_STATES.pendingActivation,
    ],
    trx,
  );

  const activated = (result?.rows || []).length > 0;
  return { activated, expiresAt: activated ? expiresAt : null };
}

/**
 * Closes an active window and hands the group to the normal fulfillment workflow.
 * CAS-guarded, so it is safe to run from several workers and safe to re-run.
 */
export async function closeGroup(
  strapi: Strapi,
  params: {
    groupId: number;
    reason: ReserveClosureReason;
    now?: Date;
    requireExpired?: boolean;
    fromStates?: ReserveGroupState[];
  },
  trx?: any,
): Promise<boolean> {
  const now = params.now || new Date();
  const fromStates = params.fromStates || [RESERVE_GROUP_STATES.active];
  const placeholders = fromStates.map(() => "?").join(", ");

  const bindings: unknown[] = [
    RESERVE_GROUP_STATES.readyToFulfill,
    params.reason,
    now,
    now,
    params.groupId,
    ...fromStates,
  ];

  let sql = `UPDATE reserve_groups
                SET state = ?,
                    closure_reason = ?,
                    closed_at = ?,
                    last_activity_at = ?,
                    updated_at = NOW()
              WHERE id = ?
                AND state IN (${placeholders})`;

  if (params.requireExpired) {
    sql += " AND expires_at IS NOT NULL AND expires_at <= ?";
    bindings.push(now);
  }

  sql += " RETURNING id";

  const result = await runRawSql(strapi, sql, bindings, trx);
  return (result?.rows || []).length > 0;
}

/** True when this order sits in a group whose parcel is still being held. */
export async function isOrderHeldByReserve(
  strapi: Strapi,
  orderId: number,
): Promise<{ held: boolean; group: ReserveGroupRow | null }> {
  const order = await strapi.db.query("api::order.order").findOne({
    where: { id: orderId },
    populate: { reserve_shipment: true },
  });
  const group = (order as { reserve_shipment?: ReserveGroupRow })?.reserve_shipment;
  if (!group) return { held: false, group: null };
  return {
    held: HELD_RESERVE_STATES.includes(group.State),
    group,
  };
}

/**
 * Called from every successful-payment path once the order is marked paid.
 *
 * First paid order  -> the window opens here and the 48h deadline is stamped.
 * Later paid order  -> membership is merely confirmed. The deadline is NOT
 *                      re-validated: the child was already bound under a lock at
 *                      finalize, so a slow gateway redirect must not retroactively
 *                      drop it out of the group. Genuinely new attachments are
 *                      rejected earlier, at finalize.
 *
 * Both branches are CAS/idempotent, so duplicate gateway callbacks are no-ops.
 */
export async function confirmReservePaymentForOrder(
  strapi: Strapi,
  orderId: number,
  trx?: any,
): Promise<
  | { outcome: "not_reserve" }
  | { outcome: "activated"; groupId: number; groupKey: string; expiresAt: Date }
  | { outcome: "attached"; groupId: number; groupKey: string; expiresAt: string | null }
  | { outcome: "noop"; groupId: number; groupKey: string }
> {
  const order: any = await strapi.db.query("api::order.order").findOne({
    where: { id: orderId },
    populate: { reserve_shipment: true },
    ...(trx ? { transacting: trx } : {}),
  } as any);

  const group = order?.reserve_shipment as ReserveGroupRow | undefined;
  if (!group?.id) return { outcome: "not_reserve" };

  await lockReserveGroup(strapi, group.id, trx);

  const fresh: any = await strapi.db.query(UID).findOne({
    where: { id: group.id },
    ...(trx ? { transacting: trx } : {}),
  } as any);
  if (!fresh) return { outcome: "not_reserve" };

  if (fresh.State === RESERVE_GROUP_STATES.pendingActivation) {
    const { activated, expiresAt } = await activateGroupOnPayment(
      strapi,
      {
        groupId: fresh.id,
        orderId,
        shippingCostPaid: Number(order?.ShippingCost || fresh.ShippingCostPaid || 0),
      },
      trx,
    );
    if (activated && expiresAt) {
      await strapi.db.query(UID).update({
        where: { id: fresh.id },
        data: { rootOrder: orderId },
        ...(trx ? { transacting: trx } : {}),
      } as any);
      return {
        outcome: "activated",
        groupId: fresh.id,
        groupKey: fresh.groupKey,
        expiresAt,
      };
    }
    return { outcome: "noop", groupId: fresh.id, groupKey: fresh.groupKey };
  }

  if (fresh.State === RESERVE_GROUP_STATES.active) {
    await strapi.db.query(UID).update({
      where: { id: fresh.id },
      data: { lastActivityAt: new Date(), lastOrderAttachedAt: new Date() },
      ...(trx ? { transacting: trx } : {}),
    } as any);
    return {
      outcome: "attached",
      groupId: fresh.id,
      groupKey: fresh.groupKey,
      expiresAt: fresh.expiresAt ?? null,
    };
  }

  return { outcome: "noop", groupId: fresh.id, groupKey: fresh.groupKey };
}

/**
 * Shipping to withhold from an order's refund because the combined parcel it paid
 * for is still going to ship.
 *
 * Returns 0 for ordinary orders and for a group with no other paid member left --
 * in that case nothing ships, so the customer gets the shipping fee back too.
 */
export async function resolveRetainedReserveShipping(
  strapi: Strapi,
  order: any,
  trx?: any,
): Promise<number> {
  const group = order?.reserve_shipment as ReserveGroupRow | undefined;
  if (!group?.id) return 0;

  const shippingToman = Math.max(0, Math.round(Number(order?.ShippingCost || 0)));
  if (shippingToman <= 0) return 0;

  const otherPaid = await strapi.db.query("api::order.order").count({
    where: {
      reserve_shipment: { id: group.id },
      id: { $ne: order.id },
      Status: { $in: ["Started", "Shipment", "Done"] },
    },
    ...(trx ? { transacting: trx } : {}),
  } as any);

  return otherPaid > 0 ? shippingToman : 0;
}

/**
 * Closes a group that has no paid members left, so an abandoned or fully
 * cancelled window stops occupying the customer's single consolidation slot.
 */
export async function closeGroupIfAbandoned(
  strapi: Strapi,
  groupId: number,
  trx?: any,
): Promise<boolean> {
  if (await hasPaidMember(strapi, groupId)) return false;

  const now = new Date();
  const result = await runRawSql(
    strapi,
    `UPDATE reserve_groups
        SET state = ?,
            closure_reason = ?,
            closed_at = ?,
            last_activity_at = ?,
            updated_at = NOW()
      WHERE id = ?
        AND state IN (?, ?)
      RETURNING id`,
    [
      RESERVE_GROUP_STATES.cancelled,
      RESERVE_CLOSURE_REASONS.rootAbandoned,
      now,
      now,
      groupId,
      RESERVE_GROUP_STATES.pendingActivation,
      RESERVE_GROUP_STATES.active,
    ],
    trx,
  );
  return (result?.rows || []).length > 0;
}

export type OrderReserveView = {
  isReserveOrder: boolean;
  reserveGroupId: string | null;
  reserveExpiresAt: string | null;
  reserveState: ReserveGroupState | null;
  reserveClosureReason: ReserveClosureReason | null;
  reserveIsActive: boolean;
  reserveIsHeld: boolean;
  reserveOrderCount?: number;
};

/**
 * Derives an order's reserve view from its group row.
 *
 * The `isReserveOrder`/`reserveExpiresAt` COLUMNS are frozen at order creation --
 * no lifecycle transition rewrites member rows, which is what keeps their
 * `updated_at` honest for the admin list. That makes the columns unsafe to read
 * directly: an expired group would still render a live countdown and a "send now"
 * button. Every read path projects through here instead.
 */
export function projectOrderReserve(order: any): OrderReserveView {
  const group = order?.reserve_shipment;
  if (!group?.id) {
    return {
      isReserveOrder: false,
      reserveGroupId: null,
      reserveExpiresAt: null,
      reserveState: null,
      reserveClosureReason: null,
      reserveIsActive: false,
      reserveIsHeld: false,
    };
  }

  const state = String(group.State || "") as ReserveGroupState;
  const expiresAt = group.expiresAt ?? null;
  const isActive =
    state === RESERVE_GROUP_STATES.active &&
    expiresAt != null &&
    new Date(expiresAt).getTime() > Date.now();

  return {
    isReserveOrder: true,
    reserveGroupId: group.groupKey ?? null,
    reserveExpiresAt: expiresAt,
    reserveState: state,
    reserveClosureReason: (group.ClosureReason ?? null) as ReserveClosureReason | null,
    reserveIsActive: isActive,
    reserveIsHeld: HELD_RESERVE_STATES.includes(state),
  };
}

/** Applies the projection onto an order payload for API responses. */
export function withReserveProjection<T extends Record<string, any>>(order: T): T & OrderReserveView {
  return { ...order, ...projectOrderReserve(order) };
}

/**
 * One parcel, one label.
 *
 * A combined shipment leaves as a single physical package, so exactly one courier
 * barcode is issued for it. This claims that barcode for the group (CAS on a NULL
 * `shipping_barcode`, so two concurrent issuances cannot both win) and then stamps
 * it onto every member order that has none.
 *
 * Copying it down to the members is deliberate: the per-order tracking column,
 * the order search and the print flows all read `orders.ShippingBarcode`, so
 * without this the tracking number would resolve back to only one of the orders
 * in the parcel. This is the one place the reserve feature writes member rows,
 * and it happens at fulfillment -- a real operational event where a fresh
 * `updated_at` is honest, unlike a lifecycle transition.
 *
 * Returns the barcode the group actually carries. When the group already had a
 * different one, that existing barcode wins and is returned unchanged; a second
 * label is never adopted.
 */
export async function claimGroupShippingBarcode(
  strapi: any,
  params: { groupId: number; barcode: string },
  trx?: unknown,
): Promise<{ barcode: string; claimed: boolean; ordersStamped: number }> {
  const claim = await runRawSql(
    strapi,
    `UPDATE reserve_groups
        SET shipping_barcode = ?, last_activity_at = NOW(), updated_at = NOW()
      WHERE id = ?
        AND shipping_barcode IS NULL
      RETURNING shipping_barcode`,
    [params.barcode, params.groupId],
    trx,
  );

  const claimed = (claim?.rows?.length ?? 0) > 0;

  let effective = params.barcode;
  if (!claimed) {
    const existing = await runRawSql(
      strapi,
      `SELECT shipping_barcode FROM reserve_groups WHERE id = ?`,
      [params.groupId],
      trx,
    );
    const current = existing?.rows?.[0]?.shipping_barcode;
    if (current) effective = String(current);
  }

  // Membership goes through the link table, NOT an `orders.reserve_shipment_id`
  // column. Strapi v4 stores every manyToOne in `<owner>_<attr>_links`, and its
  // boot-time schema sync drops any column it does not find in schema.json --
  // so a migration-added FK column silently disappears and this statement fails
  // with 42703 the first time an operator prints a combined-parcel label.
  const stamped = await runRawSql(
    strapi,
    `UPDATE orders o
        SET shipping_barcode = ?, updated_at = NOW()
       FROM orders_reserve_shipment_links l
      WHERE l.order_id = o.id
        AND l.reserve_group_id = ?
        AND (o.shipping_barcode IS NULL OR o.shipping_barcode = '')
      RETURNING o.id`,
    [effective, params.groupId],
    trx,
  );

  return {
    barcode: effective,
    claimed,
    ordersStamped: stamped?.rows?.length ?? 0,
  };
}

/**
 * The barcode already issued for this order's combined shipment, if any.
 *
 * Callers use this to adopt the parcel's existing label instead of asking the
 * courier for a second one.
 */
export async function findGroupShippingBarcode(
  strapi: any,
  order: any,
): Promise<{ groupId: number; barcode: string | null } | null> {
  const groupId = Number(order?.reserve_shipment?.id);
  if (!Number.isFinite(groupId) || groupId <= 0) return null;
  return {
    groupId,
    barcode: order.reserve_shipment.ShippingBarcode
      ? String(order.reserve_shipment.ShippingBarcode)
      : null,
  };
}
