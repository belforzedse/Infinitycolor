import type { Strapi } from "@strapi/strapi";
import type {
  ApiOrderOrder,
  ApiOrderItemOrderItem,
  ApiProductVariationProductVariation,
  ApiProductStockProductStock,
} from "../../types/generated/contentTypes";
import {
  consumeReservedStockAtomic,
  releaseReservedStockAtomic,
} from "../api/cart/services/lib/stock";
import { runRawSql } from "./transactionExecutor";
import { releaseOrderDiscountClaim } from "../api/cart/services/lib/discount-claim";
import { releaseWalletHoldsForOrder } from "../api/local-user-wallet/services/wallet-holds";

type ReservationTransition = "Released" | "Expired" | "Consumed";

export type ReleaseOrderReservationResult =
  | { outcome: "released" }
  | { outcome: "skipped" };

export type ConsumeOrderReservationResult =
  | { outcome: "consumed" }
  | {
      outcome: "skipped";
      reason: "expired" | "already_resolved" | "order_not_found";
      expired: boolean;
    };

/**
 * Valid reservation status values
 */
type ReservationStatus = "Reserved" | "Released" | "Consumed" | "Expired";

/**
 * Order fields needed for reservation status checks
 */
type OrderReservationFields = {
  id: number;
  ReservationStatus: ApiOrderOrder["attributes"]["ReservationStatus"];
  ReservedUntil: ApiOrderOrder["attributes"]["ReservedUntil"];
} | null;

/**
 * Type guard to validate and narrow ReservationStatus
 */
function isValidReservationStatus(
  value: unknown
): value is ReservationStatus {
  return (
    typeof value === "string" &&
    (value === "Reserved" ||
      value === "Released" ||
      value === "Consumed" ||
      value === "Expired")
  );
}

/**
 * Safely parse ReservedUntil value to Date or return null
 * Handles string (ISO format), number (timestamp), Date object, null, or undefined
 */
function parseReservedUntil(
  value: unknown
): Date | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    // Validate the Date object
    return isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "string") {
    if (value.trim() === "") {
      return null;
    }
    try {
      const parsed = new Date(value);
      return isNaN(parsed.getTime()) ? null : parsed;
    } catch {
      return null;
    }
  }

  if (typeof value === "number") {
    try {
      const parsed = new Date(value);
      return isNaN(parsed.getTime()) ? null : parsed;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * ProductVariation with populated product_stock relation
 */
type ProductVariationWithStock = Omit<
  ApiProductVariationProductVariation["attributes"],
  "product_stock"
> & {
  id: number;
  product_stock: ApiProductStockProductStock["attributes"] & { id: number } | null;
};

/**
 * OrderItem with populated product_variation (including product_stock)
 */
type OrderItemWithVariationAndStock = Omit<
  ApiOrderItemOrderItem["attributes"],
  "product_variation"
> & {
  id: number;
  product_variation: ProductVariationWithStock | null;
};

/**
 * Order with populated order_items (including nested product_variation and product_stock)
 */
type OrderWithItems = Omit<ApiOrderOrder["attributes"], "order_items"> & {
  id: number;
  order_items: OrderItemWithVariationAndStock[];
};

const rawSql = async (
  strapi: Strapi,
  sql: string,
  bindings: any[],
  trx?: any
) => runRawSql(strapi, sql, bindings, trx);

const loadOrderItemsWithStocks = async (
  strapi: Strapi,
  orderId: number,
  trx?: any
): Promise<OrderWithItems | null> => {
  return strapi.db.query("api::order.order").findOne({
    where: { id: orderId },
    populate: {
      order_items: {
        populate: {
          product_variation: { populate: { product_stock: true } },
        },
      },
    },
    ...(trx ? { transacting: trx } : {}),
  });
};

const transitionReservationStatus = async (
  strapi: Strapi,
  orderId: number,
  next: ReservationTransition,
  trx?: any,
  options?: {
    requireNotExpired?: boolean;
    requireOrderStatus?: "Paying";
    expiresBefore?: Date;
  }
): Promise<{ transitioned: boolean }> => {
  const requireNotExpired = options?.requireNotExpired === true;
  const clauses: string[] = [];
  const bindings: any[] = [next, orderId];

  if (requireNotExpired) {
    // Compare against a bound JS Date, NOT SQL NOW(). `reserved_until` is a Strapi
    // `datetime` → pg `timestamp without time zone` (naive), while NOW() is
    // `timestamptz`; `reserved_until >= NOW()` forces a session-timezone-dependent
    // implicit cast that misclassifies near-boundary values. A bound Date is
    // serialized the same way the value was written (and matches how the expiry
    // job filters with entityService `$lt`), making the comparison tz-consistent.
    clauses.push("reserved_until >= ?");
    bindings.push(new Date());
  }
  if (options?.requireOrderStatus) {
    clauses.push("status = ?");
    bindings.push(options.requireOrderStatus);
  }
  if (options?.expiresBefore) {
    clauses.push("reserved_until < ?");
    bindings.push(options.expiresBefore);
  }

  const extraClause = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";

  const res = await rawSql(
    strapi,
    `UPDATE orders
     SET reservation_status = ?,
         reserved_until = NULL
     WHERE id = ?
       AND reservation_status = 'Reserved'${extraClause}
     RETURNING id`,
    bindings,
    trx
  );

  const rows = res.rows || [];
  return { transitioned: rows.length > 0 };
};

export async function releaseOrderReservation(
  strapi: Strapi,
  orderId: number,
  reason: "Released" | "Expired",
  trx?: any,
  context?: {
    userId?: number | string;
    requireOrderStatus?: "Paying";
    expiresBefore?: Date;
    /**
     * Overrides the wallet hold's release reason.
     *
     * By default a hold released here is stamped `reservation_{reason}`, which
     * says only that a stock reservation ended. When the release was caused by
     * named provider evidence — a confirmed NOT_FOUND, an aged registered token
     * we reverted — the caller passes that name instead, so the hold records
     * *why* the money came back for the rest of its life. It never changes what
     * is released or whether it is released.
     */
    walletReleaseReason?: string;
  }
): Promise<ReleaseOrderReservationResult> {
  if (!trx) {
    return strapi.db.transaction(async ({ trx }) =>
      releaseOrderReservation(strapi, orderId, reason, trx, context)
    );
  }

  try {
    const { transitioned } = await transitionReservationStatus(
      strapi,
      orderId,
      reason,
      trx,
      {
        requireOrderStatus: context?.requireOrderStatus,
        expiresBefore: context?.expiresBefore,
      }
    );

    // Releasing a checkout hold also returns any limited-coupon usage the order
    // reserved. This runs on every call, not only when the reservation transition
    // matched, because the two holds can already be out of step (an expiry tick may
    // have released the stock while the coupon claim is still outstanding). The helper
    // is CAS-guarded on the claim column and refuses to release for a settled order, so
    // repeating it — or racing another failure path — decrements at most once.
    await releaseOrderDiscountClaim(strapi, orderId, trx);

    if (transitioned) {
      const order = await loadOrderItemsWithStocks(strapi, orderId, trx);
      const items = order?.order_items || [];

      for (const it of items) {
        const stockId = it?.product_variation?.product_stock?.id;
        const qty = Number(it?.Count || 0);
        if (!stockId || qty <= 0) continue;

        const result = await releaseReservedStockAtomic(
          strapi,
          Number(stockId),
          qty,
          trx,
          context
        );
        if (!result.success) {
          throw new Error(result.error || "release_reserved_failed");
        }
      }
    }

    // Wallet credit committed to this checkout goes back to spendable at the same
    // moment its stock does, with the same CAS discipline and the same refusal to
    // touch a settled order. Binding the hold's lifetime to the reservation is what
    // removes the need for any independent hold sweeper — there is no state where
    // the reservation is gone but the money is still held.
    //
    // It must come *after* the stock loop, not before it. The global lock order is
    // orders -> payment_attempts -> product_stocks -> wallet, and a settlement for
    // another order of the same customer holds the stock row while reaching for the
    // same wallet row. Taking the wallet first here closes that cycle and Postgres
    // aborts one side with a deadlock — see wallet-lock-order.int.spec.ts, which
    // reproduces it deterministically. Still unconditional: the two holds can be out
    // of step, and a CAS'd release repeats safely.
    await releaseWalletHoldsForOrder(
      strapi,
      { orderId, reason: context?.walletReleaseReason || `reservation_${reason}` },
      trx
    );

    return transitioned ? { outcome: "released" } : { outcome: "skipped" };
  } catch (e: any) {
    strapi.log.error("releaseOrderReservation failed", {
      orderId,
      reason,
      userId: context?.userId,
      error: e?.message || e,
    });
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export async function consumeOrderReservation(
  strapi: Strapi,
  orderId: number,
  trx?: any
): Promise<ConsumeOrderReservationResult> {
  if (!trx) {
    return strapi.db.transaction(async ({ trx }) =>
      consumeOrderReservation(strapi, orderId, trx)
    );
  }

  try {
    const { transitioned } = await transitionReservationStatus(
      strapi,
      orderId,
      "Consumed",
      trx,
      { requireNotExpired: true }
    );
    if (!transitioned) {
      // Either already processed, not reserved, or expired.
      // Query order to check reservation status and expiration
      const order = await strapi.db.query("api::order.order").findOne({
        where: { id: orderId },
        ...(trx ? { transacting: trx } : {}),
      });

      if (!order) {
        return {
          outcome: "skipped",
          reason: "order_not_found",
          expired: false,
        };
      }

      // Extract and validate reservation fields using type guards
      const status = order.ReservationStatus;
      const reservedUntil = order.ReservedUntil;

      // Use type guard to validate status before comparison
      const isValidStatus = isValidReservationStatus(status);
      const isReserved = isValidStatus && status === "Reserved";

      // Safely parse ReservedUntil date
      const until = parseReservedUntil(reservedUntil);

      // Check if reservation expired (status is Reserved and date is in the past)
      const expired = isReserved && until !== null && until.getTime() < Date.now();

      return {
        outcome: "skipped",
        reason: expired ? "expired" : "already_resolved",
        expired: !!expired,
      };
    }

    const order = await loadOrderItemsWithStocks(strapi, orderId, trx);
    const items = order?.order_items || [];

    for (const it of items) {
      const stockId = it?.product_variation?.product_stock?.id;
      const qty = Number(it?.Count || 0);
      if (!stockId || qty <= 0) continue;

      const result = await consumeReservedStockAtomic(
        strapi,
        Number(stockId),
        qty,
        trx
      );
      if (!result.success) {
        throw new Error(result.error || "consume_reserved_failed");
      }
    }

    return { outcome: "consumed" };
  } catch (e: any) {
    strapi.log.error("consumeOrderReservation failed", {
      orderId,
      error: e?.message || e,
    });
    throw e instanceof Error ? e : new Error(String(e));
  }
}
