import * as Sentry from "@sentry/node";
import type { Strapi } from "@strapi/strapi";

/**
 * Advisory-lock key for cart schema work. Distinct from the SnappPay family
 * (827453100-102), the external-identity migration (827453105), the payment-attempt
 * invariants (827453106) and the wallet keys (827453114-116).
 */
const CART_SCHEMA_LOCK_KEY = 827453117;

export const CART_ONE_PER_USER_INDEX = "idx_carts_one_per_user";

/**
 * At most one cart per customer — the schema's declared `oneToOne`, which Strapi only
 * enforces as a unique `(cart_id, user_id)` pair.
 *
 * Expression-only for the reason documented in `wallet-database.ts`: Strapi's
 * PostgreSQL inspector lists column-based indexes and drops the ones it does not own on
 * the next schema sync (with `ALTER TABLE … DROP CONSTRAINT`, which fails outright on a
 * plain unique index), but it cannot see an expression index. Carts have no historical
 * lifecycle — a paid order consumes lines and the same cart is reused — so the
 * uniqueness covers every linked cart, not a status subset. A retired cart is simply
 * unlinked. `carts_user_links` is a few thousand rows, so a plain (non-concurrent)
 * build takes milliseconds and can run inside a transaction.
 */
export const CART_ONE_PER_USER_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS ${CART_ONE_PER_USER_INDEX}
       ON carts_user_links ((
         CASE WHEN user_id IS NOT NULL THEN user_id ELSE NULL END
       ))`;

export const COUNT_USERS_WITH_SEVERAL_CARTS_SQL = `SELECT COUNT(*)::int AS count
    FROM (
      SELECT user_id FROM carts_user_links
       WHERE user_id IS NOT NULL
       GROUP BY user_id
      HAVING COUNT(*) > 1
    ) several`;

export const CART_INDEX_STATE_SQL = `SELECT i.indisvalid AS valid
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.relname = '${CART_ONE_PER_USER_INDEX}' AND c.relkind = 'i'`;

export type CartInvariantStatus = "skipped" | "present" | "installed" | "blocked" | "failed";

const isPostgres = (strapi: Strapi): boolean => {
  const client = String(
    (strapi.db.connection as any)?.client?.config?.client || "",
  ).toLowerCase();
  return client.includes("pg") || client.includes("postgres");
};

const shortError = (error: unknown): string =>
  String((error as any)?.message || error).slice(0, 300);

/**
 * Asserted in `bootstrap`, after schema sync, on every PostgreSQL boot.
 *
 * Never fatal and never changes data: while legacy duplicates exist the index cannot be
 * built, so this reports them and leaves installation to
 * `scripts/repair-duplicate-user-carts.js`, which consolidates the duplicates and
 * builds the index in one locked transaction. The count-then-create here is not atomic
 * with concurrent writers; a duplicate that slips in between makes the CREATE fail
 * cleanly (a non-concurrent build leaves nothing behind), which is caught below.
 */
export async function ensureCartDatabaseInvariants(strapi: Strapi): Promise<CartInvariantStatus> {
  if (!isPostgres(strapi)) return "skipped";
  const connection: any = strapi.db.connection;
  if (!(await connection.schema.hasTable("carts_user_links"))) return "skipped";

  try {
    return await connection.transaction(async (trx: any) => {
      // Transaction-scoped: a session lock taken through the pool could be released on
      // a different connection than the one holding it.
      await trx.raw("SELECT pg_advisory_xact_lock(?)", [CART_SCHEMA_LOCK_KEY]);
      await trx.raw("SET LOCAL lock_timeout = '5s'");

      const state = await trx.raw(CART_INDEX_STATE_SQL);
      const existing = state?.rows?.[0];
      if (existing) {
        if (existing.valid === true) return "present";
        strapi.log.error(
          `Cart uniqueness ${CART_ONE_PER_USER_INDEX} exists but is INVALID; drop it and re-run scripts/repair-duplicate-user-carts.js --apply.`,
        );
        return "failed";
      }

      const duplicates = await trx.raw(COUNT_USERS_WITH_SEVERAL_CARTS_SQL);
      const count = Number(duplicates?.rows?.[0]?.count || 0);
      if (count > 0) {
        strapi.log.error(
          `Cart uniqueness ${CART_ONE_PER_USER_INDEX} not installed: ${count} users have more than one cart. No data was changed; run scripts/repair-duplicate-user-carts.js.`,
        );
        try {
          Sentry.captureMessage("cart.duplicate_carts_block_uniqueness", {
            level: "warning",
            tags: { area: "cart", stage: "bootstrap" },
            extra: { usersWithSeveralCarts: count },
          });
        } catch {
          // Reporting must never block boot.
        }
        return "blocked";
      }

      await trx.raw(CART_ONE_PER_USER_INDEX_SQL);
      strapi.log.info(`Cart uniqueness ${CART_ONE_PER_USER_INDEX} installed after schema sync`);
      return "installed";
    });
  } catch (error) {
    strapi.log.error(
      `Failed to assert cart uniqueness ${CART_ONE_PER_USER_INDEX}: ${shortError(error)}`,
    );
    return "failed";
  }
}
