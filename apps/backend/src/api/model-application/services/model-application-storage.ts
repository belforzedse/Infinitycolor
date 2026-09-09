import type { Strapi } from "@strapi/strapi";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const TABLE = "model_applications";
const REQUIRED_INDEXES = new Set([
  "uq_model_applications_public_id",
  "uq_model_applications_submission_id",
  "idx_model_applications_created_id",
  "idx_model_applications_status_created_id",
]);
const migrationFilename = "2026.09.09T16.20.00.add-model-applications.js";
const migrationPath = [
  resolve(__dirname, "../../../../../database/migrations", migrationFilename),
  resolve(__dirname, "../../../../database/migrations", migrationFilename),
  resolve(process.cwd(), "database/migrations", migrationFilename),
].find(existsSync);

if (!migrationPath) {
  throw new Error(`Could not locate model application migration ${migrationFilename}`);
}
const migration = require(migrationPath) as { up: (knex: unknown) => Promise<void> };

async function missingIndexes(knex: {
  schema: { hasTable: (name: string) => Promise<boolean> };
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows?: { indexname: string }[] }>;
}): Promise<string[]> {
  if (!(await knex.schema.hasTable(TABLE))) return [...REQUIRED_INDEXES];
  const result = await knex.raw(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ?`,
    [TABLE],
  );
  const present = new Set((result?.rows || []).map((row) => row.indexname));
  return [...REQUIRED_INDEXES].filter((name) => !present.has(name));
}

export async function ensureModelApplicationStorage(
  strapi: Strapi,
): Promise<{ repaired: boolean }> {
  const knex = strapi.db?.connection as
    | {
        schema: { hasTable: (name: string) => Promise<boolean> };
        raw: (sql: string, bindings?: unknown[]) => Promise<{ rows?: { indexname: string }[] }>;
        transaction: (fn: (trx: unknown) => Promise<void>) => Promise<void>;
      }
    | undefined;
  if (!knex) throw new Error("Model application storage invariant requires a database connection");
  if (!(await knex.schema.hasTable(TABLE))) {
    throw new Error(`Model application table ${TABLE} is missing after schema synchronization`);
  }
  if ((await missingIndexes(knex)).length === 0) return { repaired: false };
  await knex.transaction(async (trx) => migration.up(trx));
  const missing = await missingIndexes(knex);
  if (missing.length > 0) {
    throw new Error(`Model application storage is missing required indexes: ${missing.join(", ")}`);
  }
  return { repaired: true };
}

export default () => ({});
