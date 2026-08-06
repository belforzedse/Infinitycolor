/**
 * Watermark bookkeeping for analytics rollup jobs (`analytics_refresh_state`).
 *
 * Every rollup job reads its watermark before doing work and only advances it after
 * a successful, fully-committed run — this is what makes a tick idempotent and a
 * backfill resumable: a crash mid-run leaves the previous watermark in place, so the
 * next tick reprocesses the same window rather than skipping it.
 */

type Knex = any;

const rowsOf = (res: any): any[] => res?.rows ?? res?.[0] ?? [];

export interface RefreshState {
  sourceType: string;
  watermark: Date | null;
  lastRunAt: Date | null;
  lastStatus: "success" | "failed" | "running" | null;
  lastError: string | null;
}

export async function getRefreshState(knex: Knex, sourceType: string): Promise<RefreshState | null> {
  const res = await knex.raw(
    `SELECT source_type, watermark, last_run_at, last_status, last_error
     FROM analytics_refresh_state WHERE source_type = ?`,
    [sourceType],
  );
  const row = rowsOf(res)[0];
  if (!row) return null;
  return {
    sourceType: row.source_type,
    watermark: row.watermark ? new Date(row.watermark) : null,
    lastRunAt: row.last_run_at ? new Date(row.last_run_at) : null,
    lastStatus: row.last_status ?? null,
    lastError: row.last_error ?? null,
  };
}

export async function markRunStarted(knex: Knex, sourceType: string): Promise<void> {
  await knex.raw(
    `
    INSERT INTO analytics_refresh_state (source_type, last_run_at, last_status, updated_at)
    VALUES (?, now(), 'running', now())
    ON CONFLICT (source_type) DO UPDATE SET
      last_run_at = now(),
      last_status = 'running',
      updated_at = now()
    `,
    [sourceType],
  );
}

export async function markRunSucceeded(
  knex: Knex,
  sourceType: string,
  watermark: Date,
): Promise<void> {
  await knex.raw(
    `
    INSERT INTO analytics_refresh_state (source_type, watermark, last_run_at, last_status, last_error, updated_at)
    VALUES (?, ?, now(), 'success', NULL, now())
    ON CONFLICT (source_type) DO UPDATE SET
      watermark = EXCLUDED.watermark,
      last_run_at = now(),
      last_status = 'success',
      last_error = NULL,
      updated_at = now()
    `,
    [sourceType, watermark],
  );
}

export async function markRunFailed(knex: Knex, sourceType: string, error: string): Promise<void> {
  await knex.raw(
    `
    INSERT INTO analytics_refresh_state (source_type, last_run_at, last_status, last_error, updated_at)
    VALUES (?, now(), 'failed', ?, now())
    ON CONFLICT (source_type) DO UPDATE SET
      last_run_at = now(),
      last_status = 'failed',
      last_error = EXCLUDED.last_error,
      updated_at = now()
    `,
    [sourceType, error.slice(0, 4000)],
  );
}
