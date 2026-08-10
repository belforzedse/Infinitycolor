import type { Strapi } from "@strapi/strapi";

/**
 * Advisory-lock key for this file's schema work. Distinct from the SnappPay
 * family (827453100-102) in snappay-database.ts and the external-identity
 * migration (827453105) — see CLAUDE.md's advisory-lock-key registry.
 */
const PAYMENT_ATTEMPT_MIGRATION_LOCK_KEY = 827453106;

const PAYMENT_ATTEMPT_INDEX_STATEMENTS = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_mellat_provider_reference
   ON payment_attempts ((
     CASE
       WHEN lower(gateway) = 'mellat'
         AND provider_reference IS NOT NULL
       THEN provider_reference
       ELSE NULL
     END
   ))`,
] as const;

/**
 * Mellat's callback correlation (verifyPaymentHandler in
 * order/controllers/helpers/payment.ts) looks up the owning payment_attempts
 * row by `providerReference` (the bank-issued RefId, echoed back on every
 * callback). Two attempts sharing a RefId would make that lookup ambiguous
 * and undermine the correlation fix for Finding A — this index is a durable
 * backstop for the in-app atomic claim (`claimPaymentAttemptForSettlement`),
 * not the primary correctness mechanism.
 *
 * Uses an expression-only index rather than a plain column UNIQUE constraint
 * for the same reason documented in snappay-database.ts: Strapi 4's
 * PostgreSQL inspector classifies column-based unique indexes as
 * constraints and tries to `ALTER TABLE ... DROP CONSTRAINT` them on the
 * next schema sync, which PostgreSQL rejects for a partial/expression index
 * and crash-loops every web instance. Expression-only indexes are not
 * misclassified. This index is deliberately not declared in
 * payment-attempt's schema.json for the same reason — Strapi must never
 * believe it owns it.
 *
 * Runs in `bootstrap` on every PostgreSQL boot (Mellat is always active,
 * unlike SnappPay's feature flag). Concurrent boots race here — even
 * `CREATE INDEX IF NOT EXISTS` is not fully atomic in Postgres — so a single
 * failure must not take the process down: log loudly and continue.
 */
export async function ensurePaymentAttemptDatabaseInvariants(strapi: Strapi): Promise<void> {
  const client = String(
    (strapi.db.connection as any)?.client?.config?.client || "",
  ).toLowerCase();
  if (!client.includes("pg") && !client.includes("postgres")) return;

  let locked = false;
  try {
    await strapi.db.connection.raw("SELECT pg_advisory_lock(?)", [
      PAYMENT_ATTEMPT_MIGRATION_LOCK_KEY,
    ]);
    locked = true;
  } catch (error: any) {
    strapi.log.error("Could not acquire the payment-attempt schema lock; proceeding unlocked", {
      error: String(error?.message || error).slice(0, 300),
    });
  }

  try {
    for (const statement of PAYMENT_ATTEMPT_INDEX_STATEMENTS) {
      try {
        await strapi.db.connection.raw(statement);
      } catch (error: any) {
        const name = statement.match(/idx_[a-z_]+/)?.[0] || "unknown_index";
        strapi.log.error("Failed to assert payment-attempt database invariant", {
          index: name,
          error: String(error?.message || error).slice(0, 300),
        });
      }
    }
  } finally {
    if (locked) {
      await strapi.db.connection
        .raw("SELECT pg_advisory_unlock(?)", [PAYMENT_ATTEMPT_MIGRATION_LOCK_KEY])
        .catch(() => undefined);
    }
  }
}
