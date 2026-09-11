import type { Strapi } from "@strapi/strapi";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const TABLE = "manual_admin_activities";
const APPEND_ONLY_TRIGGER = "manual_admin_activities_append_only";

type AuditStorageMigration = {
  up: (knex: any) => Promise<void>;
};

// Strapi runs application migrations before synchronizing content-type tables on a
// completely fresh database. In that lifecycle the forward migration correctly
// sees no legacy table and returns, but Umzug still records it as complete. Keep a
// post-schema invariant so a new installation receives the same indexes, constraints,
// legacy backfill, and append-only protection as an upgraded installation.
const migrationFilename = "2026.08.11T15.00.00.rebuild-admin-audit-events.js";
const migrationPath = [
  // Compiled runtime: dist/src/audit -> application root.
  resolve(__dirname, "../../../database/migrations", migrationFilename),
  // Source runtime (ts-node/ts-jest): src/audit -> application root.
  resolve(__dirname, "../../database/migrations", migrationFilename),
  // Strapi CLI normally runs with apps/backend as its working directory.
  resolve(process.cwd(), "database/migrations", migrationFilename),
].find(existsSync);

if (!migrationPath) {
  throw new Error(`Could not locate canonical audit migration ${migrationFilename}`);
}

const auditStorageMigration = require(migrationPath) as AuditStorageMigration;

async function hasRequiredAuditStorage(knex: any): Promise<boolean> {
  if (!(await knex.schema.hasTable(TABLE))) return false;

  // Columns Strapi schema sync has previously wiped. Missing any of these means
  // the rebuild migration must re-run; the backfill must not demote modern rows.
  const requiredColumns = [
    "event_id",
    "schema_version",
    "event_key",
    "origin",
    "actor_auth_method",
    "dedupe_key",
  ] as const;
  for (const column of requiredColumns) {
    if (!(await knex.schema.hasColumn(TABLE, column))) return false;
  }

  const [uniqueIndexes, trigger] = await Promise.all([
    knex.raw(
      `SELECT attr.attname AS column_name
         FROM pg_index AS idx
         JOIN pg_class AS table_class ON table_class.oid = idx.indrelid
         JOIN pg_namespace AS ns ON ns.oid = table_class.relnamespace
         JOIN pg_attribute AS attr
           ON attr.attrelid = table_class.oid
          AND attr.attnum = ANY(idx.indkey)
        WHERE ns.nspname = current_schema()
          AND table_class.relname = ?
          AND attr.attname IN ('event_id', 'dedupe_key')
          AND idx.indisunique = TRUE
          AND idx.indnkeyatts = 1
        GROUP BY attr.attname`,
      [TABLE],
    ),
    knex("pg_trigger")
      .where({ tgname: APPEND_ONLY_TRIGGER, tgisinternal: false })
      .first("tgname"),
  ]);

  const uniqueColumns = new Set(
    (uniqueIndexes?.rows || []).map((row: { column_name: string }) => row.column_name),
  );
  return Boolean(uniqueColumns.has("event_id") && uniqueColumns.has("dedupe_key") && trigger);
}

/**
 * Proves that the canonical audit table is ready after Strapi schema sync.
 *
 * The repair is deliberately transactional. The migration's advisory transaction
 * lock serializes concurrent web/worker boots, and a failed invariant prevents the
 * application from accepting mutations without a reliable audit store.
 */
export async function ensureAuditEventStorage(strapi: Strapi): Promise<{ repaired: boolean }> {
  const knex = (strapi as any)?.db?.connection;
  if (!knex) throw new Error("Audit storage invariant requires a database connection");
  if (!(await knex.schema.hasTable(TABLE))) {
    throw new Error(`Canonical audit table ${TABLE} is missing after schema synchronization`);
  }

  if (await hasRequiredAuditStorage(knex)) return { repaired: false };

  await knex.transaction(async (trx: any) => {
    await auditStorageMigration.up(trx);
  });

  if (!(await hasRequiredAuditStorage(knex))) {
    throw new Error("Canonical audit storage repair completed without required protections");
  }
  return { repaired: true };
}

export const __private = { hasRequiredAuditStorage };
