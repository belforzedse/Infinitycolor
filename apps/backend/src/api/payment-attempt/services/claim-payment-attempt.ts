import type { Strapi } from "@strapi/strapi";

/**
 * Atomically grants exactly one request permission to call an external
 * provider for this attempt. Losing callers must observe/reconcile the durable
 * Pending state instead of initiating a second charge.
 */
export async function claimPaymentAttemptForInitiation(strapi: Strapi, id: number) {
  const result = await strapi.db.connection.raw(
    `UPDATE payment_attempts
       SET status = 'Pending', updated_at = ?
     WHERE id = ? AND status = 'Created'
     RETURNING id`,
    [new Date(), id],
  );
  return Array.isArray(result?.rows) && result.rows.length === 1;
}

/**
 * Atomically grants exactly one caller permission to finalize (settle or
 * fail) this attempt. The guarded WHERE clause is itself the concurrency
 * control: concurrent callers racing this UPDATE serialize on Postgres's
 * row lock, and only the first to commit sees status still in the claimable
 * set, so at most one caller ever observes a truthy return. Losing callers
 * must treat this as an idempotent replay (attempt already terminal) and
 * perform no side effects.
 */
export async function claimPaymentAttemptForSettlement(
  strapi: Strapi,
  id: number,
  targetStatus: "Succeeded" | "Failed",
) {
  const result = await strapi.db.connection.raw(
    `UPDATE payment_attempts
       SET status = ?, updated_at = ?
     WHERE id = ? AND status IN ('Pending', 'Redirected')
     RETURNING id`,
    [targetStatus, new Date(), id],
  );
  return Array.isArray(result?.rows) && result.rows.length === 1;
}
