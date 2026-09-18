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
 * Serializes SnappPay `POST /token` (first mint or retarget) on a live attempt
 * so two tabs cannot mint two BNPL plans. Observe / resume of an existing
 * payment token does not need this lease — `GET /status` is idempotent and
 * must not clear another request's active mint lease on resume.
 * Losing callers must return PAYMENT_IN_PROGRESS and must not call `token`.
 */
export const SNAPPAY_INITIATION_LEASE_MS = 45_000;

export async function claimPaymentAttemptForSnappayInitiation(
  strapi: Strapi,
  id: number,
): Promise<{ leaseVersion: number } | null> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + SNAPPAY_INITIATION_LEASE_MS);
  const result = await strapi.db.connection.raw(
    `UPDATE payment_attempts
       SET lease_until = ?,
           lease_version = COALESCE(lease_version, 0) + 1,
           updated_at = ?
     WHERE id = ?
       AND status IN ('Created', 'Pending', 'Redirected', 'Unknown', 'Failed', 'Cancelled', 'Expired')
       AND (lease_until IS NULL OR lease_until < ?)
     RETURNING id, lease_version`,
    [leaseUntil, now, id, now],
  );
  const row = Array.isArray(result?.rows) ? result.rows[0] : undefined;
  const leaseVersion = Number(row?.lease_version);
  if (!row || !Number.isInteger(leaseVersion) || leaseVersion < 1) return null;
  return { leaseVersion };
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
  trx?: any,
) {
  const result = await (trx ?? strapi.db.connection).raw(
    `UPDATE payment_attempts
       SET status = ?, updated_at = ?
     WHERE id = ? AND status IN ('Pending', 'Redirected')
     RETURNING id`,
    [targetStatus, new Date(), id],
  );
  return Array.isArray(result?.rows) && result.rows.length === 1;
}
