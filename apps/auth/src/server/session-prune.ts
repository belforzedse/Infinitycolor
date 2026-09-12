import type { Pool } from "pg";

/**
 * Delete sessions that expired long enough ago to be of no further use.
 *
 * Nothing else removes them. Before this existed, `auth.sessions` held 129 rows
 * of which 68 were already expired, the oldest from five weeks earlier — the
 * table only ever grew. That is harmless for correctness (every lookup already
 * checks `expires_at`, and `disableSessionRefresh` means a session's TTL is
 * fixed at creation) but it means each lookup scans an ever-larger table, and a
 * launch that mints thousands of sessions a day would compound that daily.
 *
 * The grace period is deliberate: rows are kept for a while past expiry so an
 * operator investigating "why was I logged out" still has the row to look at.
 */
const RETENTION_DAYS = 7;
const LOOP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** Bound each pass so a long-neglected table cannot lock up behind one delete. */
const MAX_ROWS_PER_PASS = 10_000;

declare global {
  // eslint-disable-next-line no-var
  var __infinityAuthSessionPruneTimer: ReturnType<typeof setInterval> | undefined;
}

/**
 * Arbitrary but fixed: the key only has to be the same in every replica and not
 * collide with another advisory lock in this database.
 */
const PRUNE_ADVISORY_LOCK_KEY = 0x1_6f0_5e55;

export async function pruneExpiredAuthSessions(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Every auth replica runs this loop, so without a lock all of them would
    // delete the same rows on the same schedule. The transaction-scoped variant
    // releases on commit/rollback, so a crashed replica cannot wedge the others.
    const lock = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_xact_lock($1) as acquired",
      [PRUNE_ADVISORY_LOCK_KEY],
    );
    if (!lock.rows[0]?.acquired) {
      await client.query("rollback");
      return 0;
    }
    const result = await client.query(
      `delete from auth.sessions
        where ctid in (
          select ctid from auth.sessions
           where expires_at < now() - ($1 || ' days')::interval
           limit $2
        )`,
      [String(RETENTION_DAYS), MAX_ROWS_PER_PASS],
    );
    await client.query("commit");
    const deleted = result.rowCount ?? 0;
    if (deleted > 0) {
      console.log(
        JSON.stringify({ event: "auth_sessions_pruned", deleted, retentionDays: RETENTION_DAYS }),
      );
    }
    return deleted;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function kickAuthSessionPrune(pool: Pool): void {
  void pruneExpiredAuthSessions(pool).catch((error) => {
    console.error(
      JSON.stringify({
        event: "auth_sessions_prune_failed",
        reasonCode: error instanceof Error ? error.name : "UNKNOWN",
      }),
    );
  });
}

export function startAuthSessionPruneLoop(pool: Pool): void {
  if (process.env.NODE_ENV === "test" || globalThis.__infinityAuthSessionPruneTimer) return;
  kickAuthSessionPrune(pool);
  const timer = setInterval(() => kickAuthSessionPrune(pool), LOOP_INTERVAL_MS);
  // Never hold the process open for a housekeeping timer.
  timer.unref?.();
  globalThis.__infinityAuthSessionPruneTimer = timer;
}
