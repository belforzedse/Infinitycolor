import type { Strapi } from "@strapi/strapi";

/**
 * Shared advisory-lock key for all SnappPay schema work. Must match the value in
 * database/migrations/2026.07.27T12.00.00.harden-snappay-payments.js and
 * 2026.07.28T10.00.00.drop-snappay-token-encryption.js.
 */
const SNAPPAY_MIGRATION_LOCK_KEY = 827453100;

const SNAPPAY_INDEX_STATEMENTS = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_attempt_id
   ON payment_attempts (attempt_id)
   WHERE attempt_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_snappay_transaction
   ON payment_attempts (provider_reference)
   WHERE lower(gateway) = 'snappay' AND provider_reference IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_payment_attempts_snappay_due
   ON payment_attempts (next_action_at)
   WHERE lower(gateway) = 'snappay'
     AND status IN ('Pending', 'Redirected', 'Unknown')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_transactions_snappay_transaction
   ON contract_transactions (external_id)
   WHERE lower(external_source) = 'snappay'
     AND external_id IS NOT NULL
     AND gateway_status IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_payment_operations_due
   ON payment_operations (status, next_run_at, lease_until)
   WHERE status IN ('Queued', 'Processing', 'Unknown')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_operations_idempotency_key
   ON payment_operations (idempotency_key)
   WHERE idempotency_key IS NOT NULL`,
] as const;

/**
 * Strapi runs application migrations before first-boot schema synchronization.
 * On a fresh database the payment tables therefore do not exist when the
 * migration attempts to add partial indexes, so we reassert them after sync.
 *
 * This runs in `bootstrap` on every web instance. Concurrent boots race here —
 * `CREATE UNIQUE INDEX IF NOT EXISTS` is not atomic in Postgres, and existing
 * data can violate a uniqueness predicate — so a single failure must not take
 * the process down. Previously any error here crash-looped every web container
 * indefinitely. Log loudly and continue instead; the indexes are optimisations
 * and duplicate guards, not correctness prerequisites for serving traffic.
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
  // instances booting at the same time: `CREATE UNIQUE INDEX IF NOT EXISTS` is not
  // atomic in Postgres, so concurrent runs can deadlock or raise 23505 on
  // pg_class. Session-scoped so it spans the whole loop; released in `finally`.
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
      "SnappPay database invariants are incomplete; duplicate-protection indexes are missing",
      { indexes: failures },
    );
  }
}
