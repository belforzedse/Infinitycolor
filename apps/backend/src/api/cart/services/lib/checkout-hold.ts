import type { Strapi } from "@strapi/strapi";
import {
  findOrderPaymentAttempt,
  findPaymentAttempt,
} from "../../../payment-attempt/services/payment-attempt";
import { runRawSql } from "../../../../utils/transactionExecutor";
import { snappayProviderPaymentIsUnresolved } from "../../../payment-gateway/services/snappay-generation";

export type CheckoutHold = {
  attemptId: string;
  orderId: number;
  quantitiesByStockId: Map<number, number>;
  quoteHash?: string;
  gateway?: string;
  reservedUntil?: Date;
};

export type LiveCheckoutHoldDiscovery =
  | { status: "none" }
  | { status: "unavailable" }
  | { status: "held"; hold: CheckoutHold };

export type CheckoutHoldResolution =
  | { status: "missing" }
  | { status: "held"; hold: CheckoutHold }
  | { status: "expired" }
  | { status: "released" }
  | { status: "ineligible" }
  /** Identified continuation, but the reservation row could not be read. */
  | { status: "unavailable" };

const asPositiveInt = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

const orderIdFromAttempt = (attempt: { order?: unknown }): number => {
  const order = attempt.order;
  if (order && typeof order === "object" && "id" in order) {
    return asPositiveInt((order as { id: unknown }).id);
  }
  return asPositiveInt(order);
};

const userIdFromOrder = (order: { user?: unknown }): number => {
  const user = order.user;
  if (user && typeof user === "object" && "id" in user) {
    return asPositiveInt((user as { id: unknown }).id);
  }
  return asPositiveInt(user);
};

/**
 * Confirm the order still holds a live reservation with the same comparison the
 * consume/release path uses (`reserved_until >= bound Date`, not SQL NOW()).
 * A 0-row result means expiry/release already won the race — do not credit stock.
 */
const reservationIsCurrentlyHeld = async (
  strapi: Strapi,
  orderId: number,
): Promise<boolean> => {
  const result = await runRawSql(
    strapi,
    `SELECT id
       FROM orders
      WHERE id = ?
        AND status = ?
        AND reservation_status = ?
        AND reserved_until >= ?
      LIMIT 1`,
    [orderId, "Paying", "Reserved", new Date()],
  );
  const rows = (result as { rows?: Array<{ id?: unknown }> })?.rows || [];
  return rows.length > 0;
};

const quantitiesFromOrderItems = (
  order: {
    order_items?: Array<{
      Count?: unknown;
      count?: unknown;
      product_variation?: {
        product_stock?: { id?: unknown } | null;
      } | null;
    }>;
  },
): Map<number, number> => {
  const quantitiesByStockId = new Map<number, number>();
  for (const item of order.order_items || []) {
    const stockId = asPositiveInt(item.product_variation?.product_stock?.id);
    const quantity = Number(item.Count ?? item.count ?? 0);
    if (!stockId || !Number.isFinite(quantity) || quantity <= 0) continue;
    quantitiesByStockId.set(stockId, (quantitiesByStockId.get(stockId) || 0) + quantity);
  }
  return quantitiesByStockId;
};

const reservedUntilFromOrder = (order: { ReservedUntil?: unknown; reservedUntil?: unknown }): Date | undefined => {
  const raw = order.ReservedUntil ?? order.reservedUntil;
  if (!raw) return undefined;
  const parsed = raw instanceof Date ? raw : new Date(String(raw));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const holdMetadataFromAttempt = (
  attempt: { attemptId?: unknown; quoteHash?: unknown; Gateway?: unknown } | null | undefined,
  order: { ReservedUntil?: unknown; reservedUntil?: unknown },
): Pick<CheckoutHold, "attemptId" | "quoteHash" | "gateway" | "reservedUntil"> => {
  const gateway = String(attempt?.Gateway || "").trim().toLowerCase();
  return {
    attemptId: String(attempt?.attemptId || "").trim(),
    quoteHash: String(attempt?.quoteHash || "").trim() || undefined,
    gateway: gateway || undefined,
    reservedUntil: reservedUntilFromOrder(order),
  };
};

const ORDER_HOLD_POPULATE = {
  user: true,
  order_items: {
    populate: {
      product_variation: { populate: { product_stock: true } },
    },
  },
} as const;

/**
 * Discover this customer's newest live Paying reservation, independent of a
 * client-supplied attempt id. Used to credit stock so a lost localStorage key
 * cannot make the shopper's own hold look like zero free stock.
 *
 * Resume gating still uses {@link resolveEligibleCheckoutHold} for the named
 * attempt — this lookup never resurrects an expired or released order.
 */
export async function findLiveCheckoutHoldForUser(
  strapi: Strapi,
  userId: number,
): Promise<LiveCheckoutHoldDiscovery> {
  if (!Number.isInteger(userId) || userId <= 0) {
    return { status: "none" };
  }

  try {
    const orders = await strapi.db.query("api::order.order").findMany({
      where: {
        user: { id: userId },
        Status: "Paying",
        BaleCheckoutId: { $null: true },
        ReservationStatus: "Reserved",
        ReservedUntil: { $gte: new Date() },
      },
      orderBy: { id: "desc" },
      limit: 1,
      populate: ORDER_HOLD_POPULATE,
    });
    const order = Array.isArray(orders) ? orders[0] : null;
    const orderId = asPositiveInt(order?.id);
    if (!order || !orderId) {
      return { status: "none" };
    }

    if (userIdFromOrder(order) !== userId) {
      return { status: "none" };
    }

    const currentlyHeld = await reservationIsCurrentlyHeld(strapi, orderId);
    if (!currentlyHeld) {
      return { status: "none" };
    }

    const quantitiesByStockId = quantitiesFromOrderItems(order);
    if (quantitiesByStockId.size === 0) {
      return { status: "none" };
    }

    const attempt = await findOrderPaymentAttempt(strapi, orderId);
    const metadata = holdMetadataFromAttempt(attempt, order);
    return {
      status: "held",
      hold: {
        ...metadata,
        orderId,
        quantitiesByStockId,
      },
    };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Resolve a live stock hold for the exact checkout being resumed.
 *
 * Ownership is the authenticated user + attempt id (never a client-supplied
 * order id alone). Stock crediting for a lost attempt id is handled separately
 * by {@link findLiveCheckoutHoldForUser}.
 */
export async function resolveEligibleCheckoutHold(
  strapi: Strapi,
  userId: number,
  attemptId: string | undefined,
): Promise<CheckoutHoldResolution> {
  const normalizedAttemptId = String(attemptId || "").trim();
  if (!normalizedAttemptId || !Number.isInteger(userId) || userId <= 0) {
    return { status: "missing" };
  }

  try {
    const attempt = await findPaymentAttempt(strapi, userId, normalizedAttemptId);
    if (!attempt) {
      return { status: "missing" };
    }

    const orderId = orderIdFromAttempt(attempt);
    if (!orderId) {
      return { status: "ineligible" };
    }

    const order = await strapi.db.query("api::order.order").findOne({
      where: { id: orderId },
      populate: {
        user: true,
        order_items: {
          populate: {
            product_variation: { populate: { product_stock: true } },
          },
        },
      },
    });
    if (!order) {
      return { status: "ineligible" };
    }

    if (userIdFromOrder(order) !== userId) {
      return { status: "missing" };
    }

    const reservationStatus = String(order.ReservationStatus || "");
    if (reservationStatus === "Released" || reservationStatus === "Consumed") {
      return { status: "released" };
    }
    if (reservationStatus === "Expired") {
      return { status: "expired" };
    }

    const currentlyHeld = await reservationIsCurrentlyHeld(strapi, orderId);
    if (!currentlyHeld) {
      return reservationStatus === "Reserved" ? { status: "expired" } : { status: "ineligible" };
    }

    const quantitiesByStockId = quantitiesFromOrderItems(order);
    if (quantitiesByStockId.size === 0) {
      return { status: "ineligible" };
    }

    const metadata = holdMetadataFromAttempt(attempt, order);
    return {
      status: "held",
      hold: {
        ...metadata,
        attemptId: normalizedAttemptId,
        orderId,
        quantitiesByStockId,
      },
    };
  } catch {
    // A thrown query is not evidence that the hold is gone. Callers must defer.
    return { status: "unavailable" };
  }
}

export function snappayAttemptMayResumeWithoutHold(attempt: {
  Gateway?: unknown;
  Status?: unknown;
  providerStatus?: unknown;
  providerResponse?: unknown;
  providerReference?: unknown;
}): boolean {
  return (
    String(attempt.Gateway || "").toLowerCase() === "snappay" &&
    snappayProviderPaymentIsUnresolved(attempt)
  );
}
