import type { Strapi } from "@strapi/strapi";
import { runRawSql } from "../../../../utils/transactionExecutor";

/**
 * Limited-coupon usage claiming.
 *
 * A coupon with `LimitUsage > 0` must never be granted to more than that many orders.
 * The old design read `UsedTimes` nowhere on the authoritative path and only incremented
 * it at settlement, so two concurrent checkouts could both be redirected to the gateway
 * with the last remaining discount and one of them would silently lose it after paying.
 *
 * The claim is therefore taken with a guarded UPDATE inside the same transaction that
 * makes the order, its `AppliedDiscountAmount`, the contract `Amount` and the payment
 * attempt durable — that transaction is the point where the discounted total becomes the
 * amount the gateway will be asked to charge.
 *
 * `orders.DiscountUsageClaimedDiscountId` records which discount row the order holds a
 * usage of. It is an explicit claim keyed to the exact order + coupon rather than a bare
 * boolean, and it is also the CAS target that makes release idempotent.
 *
 * Unlimited coupons (`LimitUsage` null or <= 0) are deliberately untouched here: they
 * keep their existing settlement-time increment, so their behavior does not change.
 */

/**
 * Order statuses past the point where a coupon usage may be handed back.
 * These are exactly the statuses reachable only after a payment succeeded, so a stale
 * failure callback arriving late cannot refund a usage the customer genuinely consumed.
 */
const SETTLED_ORDER_STATUSES = ["Started", "Shipment", "Done", "Returned"];

export const DISCOUNT_USAGE_EXHAUSTED = "DISCOUNT_USAGE_EXHAUSTED";

export type DiscountUsageClaim = {
  claimed: boolean;
  discountId?: number;
  usedTimes?: number;
};

const firstRow = (result: any) => (result?.rows || [])[0];

/**
 * Narrows a persisted claim column to a usable discount id.
 *
 * Deliberately not `Number.isFinite(Number(value))`: `Number(null)` is 0, which is
 * finite, so that spelling reports "claim held" for every order that holds none.
 */
export const toClaimedDiscountId = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** True when the order already reserved a limited-coupon usage at checkout. */
export const hasDiscountClaim = (order: any): boolean =>
  toClaimedDiscountId(order?.DiscountUsageClaimedDiscountId) !== null;

/**
 * Claims one usage of `code` for `orderId`, if that coupon is usage-limited.
 *
 * Must be called with the transaction that persists the discounted order. Throws
 * `DISCOUNT_USAGE_EXHAUSTED` when the cap is already reached so the whole checkout rolls
 * back rather than committing an order at a discount it cannot hold.
 */
export async function claimLimitedDiscountUsage(
  strapi: Strapi,
  input: { orderId: number; code?: string | null; trx: any },
): Promise<DiscountUsageClaim> {
  const code = String(input.code || "").trim();
  if (!code) return { claimed: false };
  if (!input.trx?.raw) {
    // A claim that is not part of the order's transaction could commit while the order
    // rolls back, permanently burning a usage. Refuse rather than degrade silently.
    throw new Error("DISCOUNT_CLAIM_REQUIRES_TRANSACTION");
  }

  const discount: any = await strapi.db.query("api::discount.discount").findOne({
    where: { Code: code },
    transacting: input.trx,
  } as any);
  if (!discount?.id) return { claimed: false };

  const limit = Number(discount.LimitUsage || 0);
  if (!Number.isFinite(limit) || limit <= 0) {
    // Unlimited coupon: nothing to reserve, settlement still counts it.
    return { claimed: false };
  }

  const result = await runRawSql(
    strapi,
    `UPDATE discounts
     SET used_times = COALESCE(used_times, 0) + 1
     WHERE id = ?
       AND COALESCE(used_times, 0) < ?
     RETURNING used_times`,
    [discount.id, limit],
    input.trx,
  );

  const row = firstRow(result);
  if (!row) {
    throw new Error(
      `${DISCOUNT_USAGE_EXHAUSTED}: کد تخفیف "${code}" به سقف استفاده رسیده است`,
    );
  }

  await runRawSql(
    strapi,
    `UPDATE orders
     SET discount_usage_claimed_discount_id = ?
     WHERE id = ?`,
    [discount.id, input.orderId],
    input.trx,
  );

  strapi.log.info("Limited discount usage claimed at checkout", {
    orderId: input.orderId,
    discountId: discount.id,
    code,
    usedTimes: Number(row.used_times),
    limitUsage: limit,
  });

  return { claimed: true, discountId: Number(discount.id), usedTimes: Number(row.used_times) };
}

/**
 * Returns this order's limited-coupon usage to the pool, at most once.
 *
 * The order-side CAS is the concurrency control: only the caller whose UPDATE matches a
 * row actually decrements, so two competing failure/expiry paths cannot both release. The
 * status guard is what stops a stale failure callback arriving after a successful payment
 * from handing back a usage the customer genuinely consumed.
 */
export async function releaseOrderDiscountClaim(
  strapi: Strapi,
  orderId: number,
  trx?: any,
): Promise<{ released: boolean; discountId?: number }> {
  if (!Number.isFinite(Number(orderId))) return { released: false };

  try {
    // A transaction is required, not optional: the row lock below is what serializes
    // competing failure/expiry paths, and it only holds until commit. Opening one here
    // when the caller has none keeps standalone callers correct without ever re-entering
    // this function — a self-recursive fallback would spin forever against a transaction
    // implementation that hands back no executor.
    if (!trx?.raw) {
      return await strapi.db.transaction(async ({ trx: ownTrx }: any) => {
        if (!ownTrx?.raw) throw new Error("DISCOUNT_RELEASE_REQUIRES_TRANSACTION");
        return releaseClaimWithTransaction(strapi, orderId, ownTrx);
      });
    }
    return await releaseClaimWithTransaction(strapi, orderId, trx);
  } catch (error: any) {
    strapi.log.error("Failed to release limited discount usage", {
      orderId,
      error: error?.message || error,
    });
    return { released: false };
  }
}

async function releaseClaimWithTransaction(
  strapi: Strapi,
  orderId: number,
  trx: any,
): Promise<{ released: boolean; discountId?: number }> {
  {
    // Lock and read the claim in one step. `UPDATE ... RETURNING` cannot be used to learn
    // which discount was released: Postgres RETURNING yields post-update values, so it
    // would hand back the NULL we just wrote. `SELECT ... FOR UPDATE` is also what makes
    // this exactly-once — a second releaser blocks here, then re-evaluates its predicate
    // against the committed row, sees NULL, and matches nothing.
    const claimResult = await runRawSql(
      strapi,
      `SELECT discount_usage_claimed_discount_id AS released_discount_id
       FROM orders
       WHERE id = ?
         AND discount_usage_claimed_discount_id IS NOT NULL
         AND status NOT IN (${SETTLED_ORDER_STATUSES.map(() => "?").join(", ")})
       FOR UPDATE`,
      [orderId, ...SETTLED_ORDER_STATUSES],
      trx,
    );

    const claimRow = firstRow(claimResult);
    if (!claimRow) return { released: false };

    const discountId = toClaimedDiscountId(claimRow.released_discount_id);
    if (discountId === null) return { released: false };

    await runRawSql(
      strapi,
      `UPDATE orders
       SET discount_usage_claimed_discount_id = NULL
       WHERE id = ?`,
      [orderId],
      trx,
    );

    await runRawSql(
      strapi,
      `UPDATE discounts
       SET used_times = GREATEST(0, COALESCE(used_times, 0) - 1)
       WHERE id = ?`,
      [discountId],
      trx,
    );

    strapi.log.info("Limited discount usage released", { orderId, discountId });
    return { released: true, discountId };
  }
}

/**
 * True when this order already holds a checkout-time claim, so settlement must not
 * count the same coupon a second time.
 */
export async function orderHoldsDiscountClaim(
  strapi: Strapi,
  orderId: number,
  trx?: any,
): Promise<boolean> {
  const order: any = await strapi.db.query("api::order.order").findOne({
    where: { id: orderId },
    select: ["id", "DiscountUsageClaimedDiscountId"],
    ...(trx ? { transacting: trx } : {}),
  } as any);
  return hasDiscountClaim(order);
}
