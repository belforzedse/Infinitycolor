import type { Strapi } from "@strapi/strapi";

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
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_transactions_snappay_token_hash
   ON contract_transactions (payment_token_hash)
   WHERE payment_token_hash IS NOT NULL`,
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
 * migration attempts to add partial indexes. Reassert the security-critical
 * indexes after schema sync and fail startup if they cannot be installed.
 */
export async function ensureSnappayDatabaseInvariants(strapi: Strapi): Promise<void> {
  const client = String((strapi.db.connection as any)?.client?.config?.client || "").toLowerCase();
  if (!client.includes("pg") && !client.includes("postgres")) {
    throw new Error(
      "SNAPPAY_CONFIG_INVALID:Hardened SnappPay requires PostgreSQL database invariants",
    );
  }

  for (const statement of SNAPPAY_INDEX_STATEMENTS) {
    await strapi.db.connection.raw(statement);
  }
}
