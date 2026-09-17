"use strict";

/**
 * Production `issue_reports` string columns were created as varchar(255)
 * (Strapi's default) even after the schema declared larger maxLengths.
 * Instagram in-app browsers send user-agents well over 255 characters, so
 * POST /api/issue-reports failed with Postgres 22001 and the generic
 * «خطایی رخ داد. دوباره تلاش کنید.» — including for short customer text.
 *
 * Widen the columns that actually overflow, convert description to text if
 * it is still a varchar, and skip work once each column is already wide
 * enough. Forward-only: narrowing would recreate the truncation failures.
 * Apply through the known production deploy path only.
 */
const TABLE = "issue_reports";
const LOCK_KEY = 948_371_216;

const VARCHAR_COLUMNS = [
  { columnName: "issue_name", targetWidth: 500 },
  { columnName: "source_path", targetWidth: 2048 },
  { columnName: "user_agent", targetWidth: 4096 },
];

async function columnInfo(knex, columnName) {
  return knex("information_schema.columns")
    .select("data_type", "udt_name", "character_maximum_length")
    .where({ table_name: TABLE, column_name: columnName })
    .first();
}

function isUnlimitedText(column) {
  if (!column) return false;
  return column.data_type === "text" || column.udt_name === "text";
}

function currentWidth(column) {
  if (!column || isUnlimitedText(column)) return null;
  const width = Number(column.character_maximum_length);
  return Number.isFinite(width) ? width : null;
}

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable(TABLE))) return;

    for (const { columnName, targetWidth } of VARCHAR_COLUMNS) {
      const column = await columnInfo(knex, columnName);
      if (!column || isUnlimitedText(column)) continue;
      const width = currentWidth(column);
      if (width == null || width >= targetWidth) continue;
      await knex.raw(
        `ALTER TABLE ${TABLE} ALTER COLUMN ${columnName} TYPE varchar(${targetWidth})`,
      );
    }

    const description = await columnInfo(knex, "description");
    if (description && !isUnlimitedText(description)) {
      await knex.raw(`ALTER TABLE ${TABLE} ALTER COLUMN description TYPE text`);
    }
  },

  async down() {},
};
