import os from "os";
import type { Strapi } from "@strapi/strapi";

const ERROR_STACK_LIMIT = 4_000;
const runningJobs = new Set<string>();

export type BackgroundJobStats = Record<string, number | string | boolean | null | undefined>;

export type BackgroundJobRunResult =
  | {
      status: "completed";
      durationMs: number;
      stats: BackgroundJobStats;
    }
  | {
      status: "skipped";
      durationMs: number;
      skippedReason: "in_process" | "distributed_lock";
      stats: BackgroundJobStats;
    }
  | {
      status: "failed";
      durationMs: number;
      error: ReturnType<typeof formatError>;
      stats: BackgroundJobStats;
    };

type RunBackgroundJobOptions = {
  strapi: Strapi;
  jobName: string;
  lockTtlMs: number;
  run: () => Promise<BackgroundJobStats>;
};

export function formatError(error: unknown) {
  const asRecord = (error && typeof error === "object" ? error : {}) as {
    message?: unknown;
    code?: unknown;
    stack?: unknown;
  };

  const message =
    typeof asRecord.message === "string"
      ? asRecord.message
      : error instanceof Error
        ? error.message
        : String(error);

  const code =
    typeof asRecord.code === "string" || typeof asRecord.code === "number"
      ? asRecord.code
      : undefined;

  const stack =
    typeof asRecord.stack === "string"
      ? asRecord.stack.slice(0, ERROR_STACK_LIMIT)
      : undefined;

  return { message, code, stack };
}

function getOwner() {
  return [
    process.env.HOSTNAME,
    os.hostname(),
    process.pid,
    Math.random().toString(36).slice(2),
  ]
    .filter(Boolean)
    .join(":");
}

function isPostgresConnection(strapi: Strapi) {
  const client = String(
    (strapi.db.connection as any)?.client?.config?.client ||
      (strapi.db.connection as any)?.client?.dialect ||
      process.env.DATABASE_CLIENT ||
      ""
  ).toLowerCase();

  return client === "" || client.includes("pg") || client.includes("postgres");
}

const LOCKS_TABLE = "background_job_locks";

// Postgres "undefined_table" (42P01) — the lock table is missing. Can happen when a
// migration was recorded but its DDL was rolled back (observed in prod/staging where
// multiple instances raced migrations on boot). We must never let this silently disable
// the expiry safety net, so callers degrade to the in-process guard instead of throwing.
function isMissingLocksTableError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === "42P01") return true;
  const message = String((error as { message?: unknown })?.message ?? "");
  return message.includes(LOCKS_TABLE) && /does not exist|undefined table/i.test(message);
}

let lockTableWarned = false;

/**
 * Idempotently ensures the distributed-lock table exists. Safe to call on every boot.
 * The canonical schema lives in migration
 * 2026.05.30T12.00.00.add-background-job-locks-and-expiry-indexes.js; this is a
 * belt-and-suspenders guard for environments where that migration was recorded but its
 * table creation did not persist (concurrent-migration race across instances).
 */
export async function ensureBackgroundJobLocksTable(strapi: Strapi): Promise<void> {
  if (!isPostgresConnection(strapi)) return;
  try {
    await strapi.db.connection.raw(
      `CREATE TABLE IF NOT EXISTS ${LOCKS_TABLE} (
         name varchar(128) PRIMARY KEY,
         owner varchar(255) NOT NULL,
         locked_until timestamptz NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT NOW()
       )`
    );
  } catch (error) {
    // Non-fatal: jobs degrade to the in-process guard if the table is still unavailable.
    strapi.log.warn("Could not ensure background_job_locks table", formatError(error));
  }
}

async function acquireDistributedLock(
  strapi: Strapi,
  jobName: string,
  owner: string,
  lockTtlMs: number
) {
  if (!isPostgresConnection(strapi)) {
    strapi.log.warn("Background job distributed lock skipped for non-PostgreSQL database", {
      jobName,
      databaseClient: process.env.DATABASE_CLIENT,
    });
    return true;
  }

  const lockedUntil = new Date(Date.now() + lockTtlMs);
  try {
    const result = await strapi.db.connection.raw(
      `INSERT INTO ${LOCKS_TABLE} (name, owner, locked_until, updated_at)
       VALUES (?, ?, ?, NOW())
       ON CONFLICT (name) DO UPDATE
       SET owner = EXCLUDED.owner,
           locked_until = EXCLUDED.locked_until,
           updated_at = NOW()
       WHERE ${LOCKS_TABLE}.locked_until <= NOW()
       RETURNING name`,
      [jobName, owner, lockedUntil]
    );

    return (result?.rows || []).length > 0;
  } catch (error) {
    if (isMissingLocksTableError(error)) {
      // Degrade to the in-process guard rather than throwing, so a missing lock table
      // cannot silently disable the job. Try to self-heal the table for next time. The
      // job body is idempotent at the order level, so concurrent runs across instances
      // are safe (only one transition wins per order; the rest are skipped).
      if (!lockTableWarned) {
        lockTableWarned = true;
        strapi.log.warn(
          `${LOCKS_TABLE} table missing; running ${jobName} without distributed lock (in-process guard only)`,
          formatError(error)
        );
      }
      await ensureBackgroundJobLocksTable(strapi);
      return true;
    }
    throw error;
  }
}

async function releaseDistributedLock(strapi: Strapi, jobName: string, owner: string) {
  if (!isPostgresConnection(strapi)) return;

  await strapi.db.connection.raw(
    `UPDATE background_job_locks
     SET locked_until = NOW(),
         updated_at = NOW()
     WHERE name = ?
       AND owner = ?`,
    [jobName, owner]
  );
}

export async function runBackgroundJob({
  strapi,
  jobName,
  lockTtlMs,
  run,
}: RunBackgroundJobOptions): Promise<BackgroundJobRunResult> {
  const startedAt = Date.now();

  if (runningJobs.has(jobName)) {
    const result: BackgroundJobRunResult = {
      status: "skipped",
      skippedReason: "in_process",
      durationMs: 0,
      stats: { skipped: 1 },
    };
    strapi.log.info(`${jobName} job skipped`, result);
    return result;
  }

  const owner = getOwner();
  let lockAcquired = false;
  runningJobs.add(jobName);

  try {
    lockAcquired = await acquireDistributedLock(strapi, jobName, owner, lockTtlMs);
    if (!lockAcquired) {
      const result: BackgroundJobRunResult = {
        status: "skipped",
        skippedReason: "distributed_lock",
        durationMs: Date.now() - startedAt,
        stats: { skipped: 1 },
      };
      strapi.log.info(`${jobName} job skipped`, result);
      return result;
    }

    const stats = await run();
    const result: BackgroundJobRunResult = {
      status: "completed",
      durationMs: Date.now() - startedAt,
      stats,
    };
    strapi.log.info(`${jobName} job completed`, result);
    return result;
  } catch (error) {
    const formatted = formatError(error);
    const result: BackgroundJobRunResult = {
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: formatted,
      stats: { failed: 1 },
    };
    // Include the message in the headline: the logger drops the meta object in some
    // environments, which previously hid the root cause entirely.
    strapi.log.error(`${jobName} job failed: ${formatted.message}`, result);
    return result;
  } finally {
    if (lockAcquired) {
      try {
        await releaseDistributedLock(strapi, jobName, owner);
      } catch (releaseError) {
        strapi.log.warn(`${jobName} distributed lock release failed`, {
          jobName,
          owner,
          ...formatError(releaseError),
        });
      }
    }
    runningJobs.delete(jobName);
  }
}

export function __resetBackgroundJobGuardsForTests() {
  runningJobs.clear();
}
