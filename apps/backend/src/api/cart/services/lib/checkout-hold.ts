import type { Strapi } from "@strapi/strapi";
import { findPaymentAttempt } from "../../../payment-attempt/services/payment-attempt";
import { runRawSql } from "../../../../utils/transactionExecutor";
import { snappayProviderPaymentIsUnresolved } from "../../../payment-gateway/services/snappay-generation";

export type CheckoutHold = {
  attemptId: string;
  orderId: number;
  quantitiesByStockId: Map<number, number>;
};

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

/**
 * Resolve a live stock hold for the exact checkout being resumed.
 *
 * Ownership is the authenticated user + attempt id (never a client-supplied
 * order id alone). Another of this customer's reservations is not credited.
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

    return {
      status: "held",
      hold: {
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
