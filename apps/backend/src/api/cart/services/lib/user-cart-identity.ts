import * as Sentry from "@sentry/node";
import type { Strapi } from "@strapi/strapi";
import { resolveRawExecutor } from "../../../../utils/transactionExecutor";

/**
 * One cart per customer, resolved and created atomically across processes.
 *
 * The cart→user relation is a Strapi `oneToOne` stored in `carts_user_links`. Two
 * things made the old find-then-create unsafe once the storefront started sending the
 * guest merge and several cart reads in the same tick after login:
 *
 *  - Two requests that both read "no cart" both created one, so the user ended up with
 *    two link rows and `findOne({ user })` (LIMIT 1, no ORDER BY) returned either.
 *  - Strapi's oneToOne create first runs `DELETE FROM carts_user_links WHERE user_id = ?
 *    AND cart_id <> new` (`deletePreviousOneToAnyRelations`). A request whose read
 *    preceded the merge's commit but whose create followed it therefore *unlinked* the
 *    cart the merge had just filled. A unique index cannot catch that: it is a delete
 *    followed by an insert.
 *
 * So carts are never linked through Strapi's relation writes here. Creation takes the
 * per-user advisory lock `mergeGuestCart` already holds, re-reads, and inserts the link
 * with `ON CONFLICT DO NOTHING` against `idx_carts_one_per_user` (see `cart-database.ts`).
 * `strapi.db.transaction` has no savepoints (a nested call reuses the same trx), so a
 * caught 23505 would poison the merge's transaction; `ON CONFLICT` waits for a concurrent
 * inserter and reports zero rows instead, exactly like `getOrCreateWalletForUpdate`.
 *
 * The lock key is the bare user id on purpose: it is what the already-deployed
 * `mergeGuestCart` takes, so old and new code exclude each other during a rolling
 * deploy, and `pg_advisory_xact_lock` is re-entrant inside the merge's transaction.
 * Only the no-cart path locks, and only per user.
 */

/**
 * The user's linked carts, best first: a cart with lines before an empty one, then the
 * most recent activity, then the oldest id. With `idx_carts_one_per_user` installed there
 * is never more than one row; the order exists so the window before the duplicate repair
 * (or any future break of the invariant) resolves deterministically, never by heap
 * order. Every cart write resolves through here, so the chosen cart keeps accumulating
 * activity and stays first. `cart-repair.ts` keeps the same cart (`compareCartRank`).
 */
const LINKED_CARTS_RANKED_SQL = `
  SELECT l.cart_id
    FROM carts_user_links l
    JOIN carts c ON c.id = l.cart_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS line_count, MAX(ci.updated_at) AS last_line_at
        FROM cart_items_cart_links il
        JOIN cart_items ci ON ci.id = il.cart_item_id
       WHERE il.cart_id = l.cart_id
    ) lines ON TRUE
   WHERE l.user_id = ?
   ORDER BY (lines.line_count > 0) DESC,
            GREATEST(c.updated_at, lines.last_line_at) DESC NULLS LAST,
            l.cart_id ASC`;

/**
 * Before the repair runs, ~1.5k customers own two carts and every api replica would
 * report each of them. Report the first few per process individually, then once more
 * that the rest are being suppressed: the repair clears the condition, not the alerts.
 */
const SEVERAL_CARTS_REPORT_LIMIT = 20;
const reportedSeveralCartUsers = new Set<number>();
let severalCartsLimitAnnounced = false;

const readLinkedCartIds = async (executor: any, userId: number): Promise<number[]> => {
  const result = await executor.raw(LINKED_CARTS_RANKED_SQL, [userId]);
  return (result?.rows || []).map((row: any) => Number(row.cart_id));
};

const reportSeveralCarts = (strapi: Strapi, userId: number, cartIds: number[]) => {
  if (reportedSeveralCartUsers.has(userId)) return;
  if (reportedSeveralCartUsers.size >= SEVERAL_CARTS_REPORT_LIMIT) {
    if (!severalCartsLimitAnnounced) {
      severalCartsLimitAnnounced = true;
      strapi.log.warn(
        `cart.multiple_carts_for_user: ${SEVERAL_CARTS_REPORT_LIMIT} users reported by this process; further users are resolved the same way without individual reports.`,
      );
    }
    return;
  }
  reportedSeveralCartUsers.add(userId);
  strapi.log.warn(
    `cart.multiple_carts_for_user: user ${userId} owns carts ${cartIds.join(",")}; resolving to ${cartIds[0]}. Run scripts/repair-duplicate-user-carts.js.`,
  );
  try {
    Sentry.captureMessage("cart.multiple_carts_for_user", {
      level: "warning",
      tags: { area: "cart", stage: "resolveUserCart" },
      extra: { userId, cartIds, resolvedCartId: cartIds[0] },
    });
  } catch {
    // Reporting must never fail the cart request.
  }
};

const pickResolved = (strapi: Strapi, userId: number, cartIds: number[]): number => {
  if (cartIds.length > 1) reportSeveralCarts(strapi, userId, cartIds);
  return cartIds[0];
};

const createUserCart = async (strapi: Strapi, userId: number, trx: any): Promise<number> => {
  await trx.raw("SELECT pg_advisory_xact_lock(?)", [userId]);

  const existing = await readLinkedCartIds(trx, userId);
  if (existing.length > 0) return pickResolved(strapi, userId, existing);

  const now = new Date();
  const inserted = await trx.raw(
    `INSERT INTO carts (status, created_at, updated_at) VALUES ('Empty', ?, ?) RETURNING id`,
    [now, now],
  );
  const cartId = Number(inserted?.rows?.[0]?.id);
  if (!Number.isInteger(cartId) || cartId <= 0) {
    throw new Error("Cart row could not be created");
  }

  const linked = await trx.raw(
    `INSERT INTO carts_user_links (cart_id, user_id)
     VALUES (?, ?)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [cartId, userId],
  );
  if ((linked?.rows || []).length > 0) return cartId;

  // Someone outside this lock (an older release mid-deploy, an admin path) linked a cart
  // for this user first. Nothing references the row we just made; drop it and use theirs.
  await trx.raw(`DELETE FROM carts WHERE id = ?`, [cartId]);
  strapi.log.warn(
    `cart.create_conflict: user ${userId} already had a cart linked by a concurrent writer; discarded new cart ${cartId}.`,
  );
  const winner = await readLinkedCartIds(trx, userId);
  if (winner.length === 0) {
    throw new Error("Cart creation lost its race but no owning cart is visible");
  }
  return pickResolved(strapi, userId, winner);
};

/**
 * Returns the id of the user's cart, creating it on first use.
 *
 * Pass `trx` from inside an open transaction (the guest merge) so creation joins it and
 * rolls back with it. Without one, the common case — the cart exists — is a single
 * unlocked read.
 */
export async function resolveUserCartId(
  strapi: Strapi,
  userId: number,
  trx?: any,
): Promise<number> {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("A cart owner is required");
  }

  const executor = await resolveRawExecutor(strapi, trx);
  const existing = await readLinkedCartIds(executor, userId);
  if (existing.length > 0) return pickResolved(strapi, userId, existing);

  if (trx?.raw) return createUserCart(strapi, userId, trx);
  return strapi.db.transaction(async ({ trx: created }: any) =>
    createUserCart(strapi, userId, created),
  );
}
