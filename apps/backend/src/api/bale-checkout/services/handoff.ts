import { randomUUID } from "node:crypto";
import type { Strapi } from "@strapi/strapi";
import { chargeableVariationPrice } from "../../../utils/productAvailability";
import { isSnappayGatewayValue } from "../../payment-gateway/services/checkout-gateway-availability";
import { snappayProviderPaymentIsUnresolved } from "../../payment-gateway/services/snappay-generation";
import { validateBaleItemAvailability } from "../lib/inventory";
import {
  BALE_CHECKOUT_TTL_MS,
  BaleApiError,
  baleUnavailable,
  checkoutExpired,
  checkoutGrantUrl,
  checkoutNotFound,
  hashBaleValue,
  type BaleItem,
} from "../lib/protocol";

export { baleReturnUrl, baleStorefrontCheckoutUrl } from "../lib/protocol";

const TABLE = "bale_checkouts";
type Db = Strapi["db"]["connection"];

type CheckoutRow = {
  id: number;
  checkout_id: string;
  chat_hash: string;
  request_key_hash: string;
  request_hash: string;
  user_id: number | null;
  order_id: number | null;
  attempt_id: string | null;
  expires_at_utc: Date;
  items: BaleItem[] | string;
};

export type BaleCheckout = {
  id: number;
  checkoutId: string;
  userId: number | null;
  orderId: number | null;
  attemptId: string | null;
  expiresAt: Date;
  items: BaleItem[];
};

function checkoutRows(db: Db) {
  // Strapi stores datetimes as UTC in timestamp columns without a time zone.
  // Explicitly decode this one as UTC so API/worker timezone changes cannot move the expiry.
  return db<CheckoutRow>(TABLE).select("*", db.raw("expires_at AT TIME ZONE 'UTC' AS expires_at_utc"));
}

function toCheckout(row: CheckoutRow): BaleCheckout {
  // Strapi configures pg to return raw JSONB as text; tolerate the driver's
  // normal decoded representation too (e.g. in tests).
  const items = typeof row.items === "string" ? JSON.parse(row.items) : row.items;
  if (!Array.isArray(items)) throw baleUnavailable();
  return {
    id: row.id,
    checkoutId: row.checkout_id,
    userId: row.user_id,
    orderId: row.order_id,
    attemptId: row.attempt_id,
    expiresAt: new Date(row.expires_at_utc),
    items,
  };
}

export async function readOwnedBaleCheckout(
  strapi: Strapi, checkoutId: string, userId: number,
): Promise<BaleCheckout | null> {
  const row = await checkoutRows(strapi.db.connection)
    .where({ checkout_id: checkoutId, user_id: userId }).first();
  return row ? toCheckout(row) : null;
}

export async function lockOwnedBaleCheckout(
  trx: Db, checkoutId: string, userId: number,
): Promise<BaleCheckout | null> {
  const row = await checkoutRows(trx)
    .where({ checkout_id: checkoutId, user_id: userId }).forUpdate().first();
  return row ? toCheckout(row) : null;
}

/** The caller owns the checkout lock and is creating the order and attempt in this transaction. */
export async function linkBaleCheckoutOrder(
  trx: Db, checkout: BaleCheckout, orderId: number, attemptId: string,
): Promise<void> {
  const linked = await trx(TABLE)
    .where({ id: checkout.id, user_id: checkout.userId })
    .whereNotNull("user_id").whereNull("order_id").whereNull("attempt_id")
    .update({ order_id: orderId, attempt_id: attemptId, updated_at: new Date().toISOString() });
  if (linked !== 1) {
    throw new BaleApiError(409, "BALE_CHECKOUT_LINKED", "This checkout is already linked to an order.");
  }
}

export async function readBaleCheckoutForOrder(
  strapi: Strapi, orderId: number,
): Promise<BaleCheckout | null> {
  const row = await checkoutRows(strapi.db.connection).where({ order_id: orderId }).first();
  return row ? toCheckout(row) : null;
}

export async function readBaleCheckoutForAttempt(
  strapi: Strapi, attemptId: string, userId: number,
): Promise<BaleCheckout | null> {
  const row = await checkoutRows(strapi.db.connection)
    .where({ attempt_id: attemptId, user_id: userId }).first();
  return row ? toCheckout(row) : null;
}

export async function loadBaleCheckoutCart(strapi: Strapi, checkout: BaleCheckout) {
  const variations = await strapi.db.query("api::product-variation.product-variation").findMany({
    where: { id: { $in: checkout.items.map(({ variationId }) => variationId) } },
    populate: {
      product_stock: true,
      product_variation_color: true,
      product_variation_size: true,
      product_variation_model: true,
      product: {
        select: ["id", "Title", "Weight", "Status", "removedAt"],
        populate: { CoverImage: true, product_main_category: true },
      },
    },
  });
  const byId = new Map(variations.map((variation) => [variation.id, variation]));
  return {
    id: 0,
    Status: "Pending" as const,
    cart_items: checkout.items.map(({ variationId, quantity }) => {
      const variation = byId.get(variationId) ?? null;
      return {
        variationId,
        Count: quantity,
        Sum: quantity * chargeableVariationPrice(variation),
        product_variation: variation,
      };
    }),
  };
}

function responseFor(row: CheckoutRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new BaleApiError(409, "BALE_IDEMPOTENCY_CONFLICT", "This idempotency key already belongs to a different request.");
  }
  return {
    checkoutId: row.checkout_id,
    checkoutUrl: checkoutGrantUrl(row.checkout_id),
    expiresAt: new Date(row.expires_at_utc).toISOString(),
  };
}

export async function createBaleCheckout(
  strapi: Strapi, chatRef: string, idempotencyKey: string, items: BaleItem[],
) {
  const db = strapi.db.connection;
  const requestKeyHash = hashBaleValue([chatRef, idempotencyKey]);
  const requestHash = hashBaleValue(items);
  const findExisting = () => checkoutRows(db).where({ request_key_hash: requestKeyHash }).first();

  const existing = await findExisting();
  if (existing) return responseFor(existing, requestHash);
  if (process.env.BALE_CHECKOUT_NEW_ENABLED?.trim().toLowerCase() === "false") {
    throw new BaleApiError(503, "BALE_NEW_CHECKOUTS_DISABLED", "New checkout links are temporarily unavailable.");
  }

  const checkoutId = randomUUID();
  const checkoutUrl = checkoutGrantUrl(checkoutId); // Fail before writing if link configuration is missing.
  try {
    await validateBaleItemAvailability(strapi, items);
  } catch (error) {
    // A concurrent request may already have succeeded before the availability check finished.
    if (!(error instanceof BaleApiError) || error.code !== "BALE_ITEMS_UNAVAILABLE") throw error;
    const concurrent = await findExisting();
    if (concurrent) return responseFor(concurrent, requestHash);
    throw error;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + BALE_CHECKOUT_TTL_MS);
  const [inserted] = await db(TABLE).insert({
    checkout_id: checkoutId,
    chat_hash: hashBaleValue(chatRef),
    request_key_hash: requestKeyHash,
    request_hash: requestHash,
    items: JSON.stringify(items),
    expires_at: expiresAt.toISOString(),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }).onConflict("request_key_hash").ignore().returning("id");

  if (inserted) return { checkoutId, checkoutUrl, expiresAt: expiresAt.toISOString() };
  const winner = await findExisting();
  if (!winner) throw baleUnavailable();
  return responseFor(winner, requestHash);
}

export async function claimBaleCheckout(strapi: Strapi, checkoutId: string, userId: number) {
  return strapi.db.connection.transaction(async (trx) => {
    const row = await checkoutRows(trx).where({ checkout_id: checkoutId }).forUpdate().first();
    if (!row || (row.user_id !== null && row.user_id !== userId)) throw checkoutNotFound();
    const checkout = toCheckout(row);
    requireActiveBaleCheckout(checkout);
    if (row.user_id === null) {
      await trx(TABLE).where({ id: row.id }).update({ user_id: userId, updated_at: new Date().toISOString() });
    }
    return { ...checkout, userId };
  });
}

export function requireActiveBaleCheckout(checkout: BaleCheckout) {
  // An already-created order stays accessible after the initial handoff expires.
  if (checkout.orderId === null && checkout.expiresAt.getTime() <= Date.now()) throw checkoutExpired();
}

export type BaleCheckoutStatus = "ready" | "payment_pending" | "paid" | "failed" | "cancelled" | "expired";

type CheckoutStatusRow = {
  order_number: number | null;
  order_id: number | null;
  order_status: string | null;
  reservation_status: string | null;
  attempt_status: string | null;
  gateway: string | null;
  provider_status: string | null;
  provider_response: unknown;
  expires_at_utc: Date;
};

function readStatus(row: CheckoutStatusRow): BaleCheckoutStatus {
  if (row.order_id === null) {
    return new Date(row.expires_at_utc).getTime() <= Date.now() ? "expired" : "ready";
  }
  if (row.order_number === null || !row.attempt_status) throw baleUnavailable();
  if (row.attempt_status !== "Succeeded" && isSnappayGatewayValue(row.gateway)) {
    const providerResponse = typeof row.provider_response === "string"
      ? JSON.parse(row.provider_response)
      : row.provider_response;
    if (snappayProviderPaymentIsUnresolved({
      Status: row.attempt_status,
      providerStatus: row.provider_status,
      providerResponse,
    })) {
      return "payment_pending";
    }
  }
  switch (row.attempt_status) {
    case "Succeeded": return "paid";
    case "Failed": return "failed";
    case "Cancelled": return "cancelled";
    case "Expired": return "expired";
    case "Created":
      if (row.order_status === "Cancelled") {
        return row.reservation_status === "Expired" ? "expired" : "cancelled";
      }
      break;
  }
  // A clock or an order reservation alone cannot resolve a dispatched payment.
  return "payment_pending";
}

export async function readBaleCheckoutStatus(strapi: Strapi, checkoutId: string, chatRef: string) {
  const { rows } = await strapi.db.connection.raw<{ rows: CheckoutStatusRow[] }>(
    `SELECT b.expires_at AT TIME ZONE 'UTC' AS expires_at_utc, b.order_id, o.id AS order_number,
            o.status AS order_status, o.reservation_status, pa.status AS attempt_status,
            pa.gateway, pa.provider_status, pa.provider_response
       FROM bale_checkouts b
       LEFT JOIN orders o ON o.id = b.order_id
       LEFT JOIN payment_attempts pa ON pa.attempt_id = b.attempt_id
        AND EXISTS (
          SELECT 1 FROM payment_attempts_order_links l
           WHERE l.payment_attempt_id = pa.id AND l.order_id = o.id
        )
      WHERE b.checkout_id = ? AND b.chat_hash = ?`,
    [checkoutId, hashBaleValue(chatRef)],
  );
  const row = rows[0];
  if (!row) throw checkoutNotFound();
  const status = readStatus(row);
  return {
    checkoutId,
    status,
    ...(status === "paid" && row.order_number !== null ? { orderNumber: row.order_number } : {}),
  };
}

// Strapi discovers modules in services/; callers use the named helpers above.
export default () => ({});
