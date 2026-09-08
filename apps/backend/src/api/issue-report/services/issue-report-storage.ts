import type { Strapi } from "@strapi/strapi";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const TABLE = "issue_reports";
const REQUIRED_INDEXES = new Set([
  "uq_issue_reports_public_id",
  "uq_issue_reports_submission_id",
  "idx_issue_reports_created_id",
  "idx_issue_reports_status_created_id",
  "idx_issue_reports_contact_prefix",
  "idx_issue_reports_issue_name_trgm",
]);
const migrationFilename = "2026.09.08T13.00.00.add-issue-reports.js";
const migrationPath = [
  resolve(__dirname, "../../../../../database/migrations", migrationFilename),
  resolve(__dirname, "../../../../database/migrations", migrationFilename),
  resolve(process.cwd(), "database/migrations", migrationFilename),
].find(existsSync);

if (!migrationPath) throw new Error(`Could not locate issue report migration ${migrationFilename}`);
const migration = require(migrationPath) as { up: (knex: any) => Promise<void> };

async function missingIndexes(knex: any): Promise<string[]> {
  if (!(await knex.schema.hasTable(TABLE))) return [...REQUIRED_INDEXES];
  const result = await knex.raw(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ?`,
    [TABLE],
  );
  const present = new Set((result?.rows || []).map((row: any) => row.indexname));
  return [...REQUIRED_INDEXES].filter((name) => !present.has(name));
}

export async function ensureIssueReportStorage(strapi: Strapi): Promise<{ repaired: boolean }> {
  const knex = (strapi as any)?.db?.connection;
  if (!knex) throw new Error("Issue report storage invariant requires a database connection");
  if (!(await knex.schema.hasTable(TABLE))) {
    throw new Error(`Issue report table ${TABLE} is missing after schema synchronization`);
  }
  if ((await missingIndexes(knex)).length === 0) return { repaired: false };
  await knex.transaction(async (trx: any) => migration.up(trx));
  const missing = await missingIndexes(knex);
  if (missing.length > 0) {
    throw new Error(`Issue report storage is missing required indexes: ${missing.join(", ")}`);
  }
  return { repaired: true };
}

export const __private = { missingIndexes, REQUIRED_INDEXES };

export default () => ({});
