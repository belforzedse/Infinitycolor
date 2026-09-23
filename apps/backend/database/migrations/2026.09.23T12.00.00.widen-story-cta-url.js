"use strict";

/**
 * Story CTA links were declared `maxLength: 500` but stored in Strapi's default
 * varchar(255). Percent-encoded Persian `/pdp/` links routinely exceed 255
 * characters, so saving one would fail with Postgres 22001 and surface as the
 * admin's generic «خطای سرور».
 *
 * The schemas now declare `columnType` varchar(2048), which covers fresh
 * databases; this migration widens existing ones. Production was widened by
 * hand on 2026-09-23, so it is a no-op there. Stay on varchar: Strapi's schema
 * diff ignores varchar length but would revert a `text` column to varchar(255).
 * Forward-only: narrowing would recreate the failure.
 */
const LOCK_KEY = 948_371_217;
const TARGET_WIDTH = 2048;
const TABLES = ["stories", "components_story_story_items"];
const COLUMN = "cta_url";

async function columnInfo(knex, table) {
  return knex("information_schema.columns")
    .select("data_type", "udt_name", "character_maximum_length")
    .where({ table_name: table, column_name: COLUMN })
    .first();
}

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);

    for (const table of TABLES) {
      if (!(await knex.schema.hasTable(table))) continue;
      const column = await columnInfo(knex, table);
      if (!column || column.data_type === "text" || column.udt_name === "text") continue;
      const width = Number(column.character_maximum_length);
      if (!Number.isFinite(width) || width >= TARGET_WIDTH) continue;
      await knex.raw(`ALTER TABLE ${table} ALTER COLUMN ${COLUMN} TYPE varchar(${TARGET_WIDTH})`);
    }
  },

  async down() {},
};
