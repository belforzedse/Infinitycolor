import type { Strapi } from "@strapi/strapi";

/**
 * Shared advisory-lock key for all SnappPay schema work. Must match the value in
 * database/migrations/2026.07.27T12.00.00.harden-snappay-payments.js and
 * 2026.07.28T10.00.00.drop-snappay-token-encryption.js.
 */
const SNAPPAY_MIGRATION_LOCK_KEY = 827453100;

const SNAPPAY_UNIQUE_CONSTRAINTS = [
  {
    name: "payment_attempts_attempt_id_unique",
    table: "payment_attempts",
    statement: `ALTER TABLE payment_attempts
      ADD CONSTRAINT payment_attempts_attempt_id_unique UNIQUE (attempt_id)`,
  },
  {
    name: "payment_operations_idempotency_key_unique",
    table: "payment_operations",
    statement: `ALTER TABLE payment_operations
      ADD CONSTRAINT payment_operations_idempotency_key_unique UNIQUE (idempotency_key)`,
  },
] as const;

const SNAPPAY_INDEX_STATEMENTS = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_snappay_transaction
   ON payment_attempts ((
     CASE
       WHEN lower(gateway) IN ('snappay', 'snapppay')
         AND provider_reference IS NOT NULL
       THEN provider_reference
       ELSE NULL
     END
   ))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_transactions_snappay_transaction
   ON contract_transactions ((
     CASE
       WHEN lower(external_source) IN ('snappay', 'snapppay')
         AND external_id IS NOT NULL
         AND gateway_status IS NOT NULL
       THEN external_id
       ELSE NULL
     END
   ))`,
  `CREATE INDEX IF NOT EXISTS idx_payment_attempts_snappay_due
   ON payment_attempts (next_action_at)
   WHERE lower(gateway) IN ('snappay', 'snapppay')
     AND status IN ('Pending', 'Redirected', 'Unknown')`,
  `CREATE INDEX IF NOT EXISTS idx_payment_operations_due
   ON payment_operations (status, next_run_at, lease_until)
   WHERE status IN ('Queued', 'Processing', 'Unknown')`,
] as const;

/**
 * Strapi runs application migrations before first-boot schema synchronization.
 * On a fresh database the payment tables therefore do not exist when the
 * migration attempts to add constraints or partial indexes, so we reassert the
 * globally unique identifiers as real constraints and the non-unique recovery
 * indexes after sync.
 *
 * This runs in `bootstrap` on every web instance. Concurrent boots race here —
 * even `CREATE INDEX IF NOT EXISTS` is not fully atomic in Postgres — so a
 * single failure must not take the process down. Log loudly and continue
 * instead; these indexes are recovery-query optimisations, not correctness
 * prerequisites for serving traffic.
 *
 * Manual column-based UNIQUE indexes are deliberately excluded. Strapi mistakes
 * them for constraints on its next schema sync and attempts to drop them with
 * `ALTER TABLE ... DROP CONSTRAINT`, which crash-loops the process. Real UNIQUE
 * constraints are compatible with that reconciliation path. The two conditional
 * provider guards use expression-only indexes: Strapi 4's PostgreSQL inspector
 * does not classify expression-only entries as column indexes, while PostgreSQL
 * still enforces their uniqueness.
 */
export async function ensureSnappayDatabaseInvariants(strapi: Strapi): Promise<void> {
  const client = String((strapi.db.connection as any)?.client?.config?.client || "").toLowerCase();
  if (!client.includes("pg") && !client.includes("postgres")) {
    throw new Error(
      "SNAPPAY_CONFIG_INVALID:Hardened SnappPay requires PostgreSQL database invariants",
    );
  }

  const failures: string[] = [];
  // Serialize against the SnappPay migrations and against the other five web
  // instances booting at the same time. Concurrent index DDL can deadlock or
  // collide in pg_class. Session-scoped so it spans the whole loop; released in
  // `finally`.
  let locked = false;
  try {
    await strapi.db.connection.raw("SELECT pg_advisory_lock(?)", [
      SNAPPAY_MIGRATION_LOCK_KEY,
    ]);
    locked = true;
  } catch (error: any) {
    strapi.log.error("Could not acquire the SnappPay schema lock; proceeding unlocked", {
      error: String(error?.message || error).slice(0, 300),
    });
  }

  try {
    for (const constraint of SNAPPAY_UNIQUE_CONSTRAINTS) {
      const existing = await strapi.db.connection.raw(
        `SELECT 1
         FROM pg_constraint
         WHERE conname = ?
           AND conrelid = to_regclass(?)
           AND contype = 'u'
         LIMIT 1`,
        [constraint.name, constraint.table],
      );
      if (existing.rows.length > 0) continue;

      try {
        await strapi.db.connection.raw(constraint.statement);
      } catch (error: any) {
        strapi.log.error("Failed to assert required SnappPay uniqueness constraint", {
          constraint: constraint.name,
          error: String(error?.message || error).slice(0, 300),
        });
        throw new Error(
          `SNAPPAY_DATABASE_INVARIANT_MISSING:${constraint.name}`,
        );
      }
    }

    for (const statement of SNAPPAY_INDEX_STATEMENTS) {
      try {
        await strapi.db.connection.raw(statement);
      } catch (error: any) {
        const name = statement.match(/idx_[a-z_]+/)?.[0] || "unknown_index";
        failures.push(name);
        strapi.log.error("Failed to assert SnappPay database invariant", {
          index: name,
          error: String(error?.message || error).slice(0, 300),
        });
      }
    }
  } finally {
    if (locked) {
      await strapi.db.connection
        .raw("SELECT pg_advisory_unlock(?)", [SNAPPAY_MIGRATION_LOCK_KEY])
        .catch(() => undefined);
    }
  }
  if (failures.length > 0) {
    strapi.log.error(
      "SnappPay database invariants are incomplete; secondary indexes are missing",
      { indexes: failures },
    );
  }
}
