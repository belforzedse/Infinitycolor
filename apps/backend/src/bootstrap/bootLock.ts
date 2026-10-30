import type { Strapi } from "@strapi/strapi";

/**
 * One backend process at a time does the database work of a boot.
 *
 * api, worker, media-worker and scheduler all run Strapi, and a release starts
 * many of them at once. Two things each one does at boot are not safe side by
 * side:
 * - Strapi's schema sync (when the schema hash changed or migrations are
 *   pending) drops every index its models do not declare, with a plain
 *   `DROP INDEX`. When two processes drop the same index, the second fails with
 *   "does not exist" and the task exits (staging, 2026-09-25: the media-worker
 *   on `idx_issue_reports_contact_prefix`, and Swarm rolled it back).
 * - The invariant repairs in bootstrap then recreate those indexes, triggers
 *   and constraints, and `CREATE ... IF NOT EXISTS` still collides when two
 *   sessions run it at the same moment.
 *
 * A Postgres advisory lock serialises both sections across every process on
 * the database, the way schema-migration tools guard their runs. The first
 * process does the work; the others then find the schema current and the
 * invariants in place, and pass through in milliseconds. The lock lives on one
 * pooled connection and dies with it, so a process that crashes mid-boot never
 * leaves it held, and a waiter gives up after BOOT_LOCK_TIMEOUT_MS instead of
 * hanging a rollout.
 */

// The 8274531xx advisory keys are this backend's (AGENT-REFERENCE.md lists
// them); migrations and invariant repairs take their own keys inside this one.
export const BOOT_LOCK_KEY = 827453118;
const DEFAULT_TIMEOUT_MS = 300_000;

type PgConnection = { query: (text: string, values?: unknown[]) => Promise<unknown> };

type KnexLike = {
  client?: {
    config?: { client?: string };
    acquireConnection: () => Promise<PgConnection>;
    releaseConnection: (connection: PgConnection) => Promise<unknown>;
  };
};

type LogLike = { info: (message: string) => void };

type StrapiLike = { db?: { connection?: unknown }; log: LogLike };

export type ReleaseBootLock = () => Promise<void>;

const isPostgres = (knex: KnexLike | undefined) =>
  /pg|postgres/i.test(String(knex?.client?.config?.client || ""));

const timeoutMs = () => {
  const value = Number.parseInt(process.env.BOOT_LOCK_TIMEOUT_MS || "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
};

export async function acquireBootLock(strapi: StrapiLike, section: string): Promise<ReleaseBootLock> {
  const knex = strapi.db?.connection as KnexLike | undefined;
  if (!knex?.client || !isPostgres(knex)) return async () => undefined;

  const client = knex.client;
  const connection = await client.acquireConnection();
  const limit = timeoutMs();
  const started = Date.now();
  try {
    await connection.query(`SET lock_timeout = ${limit}`);
    // A blocking SELECT keeps a snapshot while it waits. Concurrent expression
    // index builds under this lock would wait for that snapshot, while the
    // waiting boot needs this lock to finish: neither can make progress.
    // End each try's transaction before sleeping, on the same pinned session.
    while (true) {
      if (Date.now() - started >= limit) throw new Error("timed out waiting for another boot");
      const result = await connection.query("SELECT pg_try_advisory_lock($1) AS locked", [BOOT_LOCK_KEY]) as {
        rows: Array<{ locked: boolean }>;
      };
      if (result.rows[0]?.locked) break;
      const remaining = limit - (Date.now() - started);
      if (remaining <= 0) throw new Error("timed out waiting for another boot");
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
  } catch (error) {
    await connection.query("SET lock_timeout = DEFAULT").catch(() => undefined);
    await client.releaseConnection(connection);
    throw new Error(
      `Could not take the boot lock for ${section} within ${limit} ms: ${(error as Error).message}`,
    );
  }
  await connection.query("SET lock_timeout = DEFAULT");
  strapi.log.info(`Boot lock taken for ${section} after ${Date.now() - started} ms`);

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await connection.query("SELECT pg_advisory_unlock($1)", [BOOT_LOCK_KEY]);
    } finally {
      await client.releaseConnection(connection);
    }
  };
}

export async function withBootLock<T>(
  strapi: StrapiLike,
  section: string,
  work: () => Promise<T>,
): Promise<T> {
  const release = await acquireBootLock(strapi, section);
  try {
    return await work();
  } finally {
    await release();
  }
}

type SyncHooks = {
  hook: (name: "strapi::content-types.beforeSync" | "strapi::content-types.afterSync") => {
    register: (fn: () => Promise<void>) => void;
  };
};

/**
 * Holds the boot lock across Strapi's schema sync. Strapi runs `beforeSync`
 * handlers in parallel but calls `db.schema.sync()` only once all of them have
 * resolved, so the sync (with the migrations and repairs it runs) happens under
 * the lock. If the sync throws, `afterSync` never runs and the boot fails; the
 * process exits and its connection, and with it the lock, goes away.
 */
export const registerSchemaSyncLock = (strapi: Strapi) => {
  const hooks = strapi as Strapi & SyncHooks;
  let release: ReleaseBootLock | undefined;
  hooks.hook("strapi::content-types.beforeSync").register(async () => {
    release = await acquireBootLock(strapi as unknown as StrapiLike, "the schema sync");
  });
  hooks.hook("strapi::content-types.afterSync").register(async () => {
    const releaseNow = release;
    release = undefined;
    await releaseNow?.();
  });
};
