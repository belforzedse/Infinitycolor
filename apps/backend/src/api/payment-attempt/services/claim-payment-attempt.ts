import type { Strapi } from "@strapi/strapi";

/**
 * Atomically grants exactly one request permission to call an external
 * provider for this attempt. Losing callers must observe/reconcile the durable
 * Pending state instead of initiating a second charge.
 */
export async function claimPaymentAttemptForInitiation(
  strapi: Strapi,
  id: number,
) {
  const result = await strapi.db.connection.raw(
    `UPDATE payment_attempts
       SET status = 'Pending', updated_at = ?
     WHERE id = ? AND status = 'Created'
     RETURNING id`,
    [new Date(), id],
  );
  return Array.isArray(result?.rows) && result.rows.length === 1;
}
