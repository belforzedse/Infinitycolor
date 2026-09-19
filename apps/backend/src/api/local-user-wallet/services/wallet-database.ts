import type { Strapi } from "@strapi/strapi";

/**
 * Advisory-lock key for wallet schema work. Distinct from the SnappPay family
 * (827453100-102), the external-identity migration (827453105) and the
 * payment-attempt invariants (827453106).
 */
const WALLET_MIGRATION_LOCK_KEY = 827453114;

/**
 * Uniqueness the wallet ledger depends on, asserted after schema sync.
 *
 * Strapi 4's `unique: true` on a scalar attribute is a *content-type* flag: it
 * never reaches `createColumn`, which only reads `attribute.column.unique` (see
 * `@strapi/database` 4.25.21 `createTable`/`getColumnType`). That is why
 * `local_user_wallet_transactions.reference_id` and `wallet_topups.sale_order_id`
 * have no database uniqueness today even though both schemas declare it, and why
 * every "idempotent" wallet credit currently relies on a read-then-write check
 * with no backstop.
 *
 * All five are written as expression-only indexes for the reason documented in
 * `snappay-database.ts`: Strapi's PostgreSQL inspector lists column-based
 * indexes and drops any it does not own on the next schema sync, but it cannot
 * see expression-only entries (`getIndexes` joins `pg_attribute` on
 * `a.attnum = ANY(ix.indkey)`, and an expression contributes attnum 0). The
 * uniqueness therefore survives every boot instead of being dropped and
 * re-added in a race with live traffic.
 *
 * A failure here is never fatal: duplicates in legacy data must leave the
 * process serving traffic. `wallet-readiness.ts` re-reads the result and keeps
 * the affected capability switched off until an operator repairs the data.
 */
const WALLET_UNIQUE_INDEXES = [
  {
    name: "idx_local_user_wallets_one_per_user",
    statement: `CREATE UNIQUE INDEX IF NOT EXISTS idx_local_user_wallets_one_per_user
       ON local_user_wallets_user_links ((
         CASE WHEN user_id IS NOT NULL THEN user_id ELSE NULL END
       ))`,
  },
  {
    name: "idx_wallet_transactions_reference_id",
    statement: `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_reference_id
       ON local_user_wallet_transactions ((
         CASE WHEN reference_id IS NOT NULL THEN reference_id ELSE NULL END
       ))`,
  },
  {
    name: "idx_wallet_topups_sale_order_id",
    statement: `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_topups_sale_order_id
       ON wallet_topups ((
         CASE WHEN sale_order_id IS NOT NULL THEN sale_order_id ELSE NULL END
       ))`,
  },
  {
    name: "idx_wallet_topups_idempotency_key",
    statement: `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_topups_idempotency_key
       ON wallet_topups ((
         CASE WHEN idempotency_key IS NOT NULL THEN idempotency_key ELSE NULL END
       ))`,
  },
  {
    name: "idx_wallet_topups_one_owner",
    statement: `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_topups_one_owner
       ON wallet_topups_user_links ((
         CASE WHEN wallet_topup_id IS NOT NULL THEN wallet_topup_id ELSE NULL END
       ))`,
  },
] as const;

/**
 * Money invariants. CHECK constraints are the one object class Strapi's schema
 * diff has no concept of (the 4.25.21 bundle contains no check handling at
 * all), so they are installed once and then left alone.
 *
 * `held_balance` and `balance` are both nullable — Strapi applies `required`
 * and `default` in the entity layer, not in DDL, and forcing NOT NULL here
 * would be diffed back on the next sync. Every predicate therefore COALESCEs.
 */
const WALLET_CHECK_CONSTRAINTS = [
  {
    name: "chk_local_user_wallets_balance_nonneg",
    table: "local_user_wallets",
    expression: "COALESCE(balance, 0) >= 0",
  },
  {
    name: "chk_local_user_wallets_held_within_balance",
    table: "local_user_wallets",
    expression:
      "COALESCE(held_balance, 0) >= 0 AND COALESCE(held_balance, 0) <= COALESCE(balance, 0)",
  },
] as const;

const isPostgres = (strapi: Strapi): boolean => {
  const client = String(
    (strapi.db.connection as any)?.client?.config?.client || "",
  ).toLowerCase();
  return client.includes("pg") || client.includes("postgres");
};

const shortError = (error: unknown): string =>
  String((error as any)?.message || error).slice(0, 300);

async function constraintExists(strapi: Strapi, name: string): Promise<boolean> {
  const result = await strapi.db.connection.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? LIMIT 1`,
    [name],
  );
  return (result?.rows || []).length > 0;
}

/**
 * Adds a CHECK constraint without blocking on legacy rows: NOT VALID applies it
 * to every new write immediately, and VALIDATE runs only when the table has no
 * violating row. A table that does violate keeps the constraint in its NOT VALID
 * form (new writes still guarded) and reports itself through readiness; no row
 * is ever altered, merged or deleted to make a constraint pass.
 */
async function ensureCheckConstraint(
  strapi: Strapi,
  constraint: (typeof WALLET_CHECK_CONSTRAINTS)[number],
): Promise<void> {
  if (!(await constraintExists(strapi, constraint.name))) {
    await strapi.db.connection.raw(
      `ALTER TABLE ${constraint.table}
         ADD CONSTRAINT ${constraint.name} CHECK (${constraint.expression}) NOT VALID`,
    );
  }
  const validated = await strapi.db.connection.raw(
    `SELECT convalidated FROM pg_constraint WHERE conname = ? LIMIT 1`,
    [constraint.name],
  );
  if (validated?.rows?.[0]?.convalidated === true) return;

  const violations = await strapi.db.connection.raw(
    `SELECT COUNT(*)::int AS count FROM ${constraint.table} WHERE NOT (${constraint.expression})`,
  );
  const count = Number(violations?.rows?.[0]?.count || 0);
  if (count > 0) {
    strapi.log.error(
      `Wallet constraint ${constraint.name} left NOT VALID: ${count} legacy rows violate it. New writes are still checked; repair the data before enabling wallet capabilities.`,
    );
    return;
  }
  await strapi.db.connection.raw(
    `ALTER TABLE ${constraint.table} VALIDATE CONSTRAINT ${constraint.name}`,
  );
}

/**
 * Asserted in `bootstrap`, after schema sync, on every PostgreSQL boot — the
 * same contract as `ensureSnappayDatabaseInvariants` and
 * `ensurePaymentAttemptDatabaseInvariants`. Concurrent boots race here, so no
 * single statement failure may take the process down.
 */
export async function ensureWalletDatabaseInvariants(strapi: Strapi): Promise<void> {
  if (!isPostgres(strapi)) return;

  let locked = false;
  try {
    await strapi.db.connection.raw("SELECT pg_advisory_lock(?)", [WALLET_MIGRATION_LOCK_KEY]);
    locked = true;
  } catch (error) {
    strapi.log.error(
      `Could not acquire the wallet schema lock; proceeding unlocked: ${shortError(error)}`,
    );
  }

  try {
    for (const index of WALLET_UNIQUE_INDEXES) {
      try {
        await strapi.db.connection.raw(index.statement);
      } catch (error) {
        strapi.log.error(
          `Failed to assert wallet uniqueness ${index.name}: ${shortError(error)}`,
        );
      }
    }
    for (const constraint of WALLET_CHECK_CONSTRAINTS) {
      try {
        await ensureCheckConstraint(strapi, constraint);
      } catch (error) {
        strapi.log.error(
          `Failed to assert wallet constraint ${constraint.name}: ${shortError(error)}`,
        );
      }
    }
  } finally {
    if (locked) {
      await strapi.db.connection
        .raw("SELECT pg_advisory_unlock(?)", [WALLET_MIGRATION_LOCK_KEY])
        .catch(() => undefined);
    }
  }
}

export const __private = {
  WALLET_MIGRATION_LOCK_KEY,
  WALLET_UNIQUE_INDEXES,
  WALLET_CHECK_CONSTRAINTS,
};
