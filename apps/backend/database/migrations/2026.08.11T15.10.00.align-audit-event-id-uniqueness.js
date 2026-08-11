"use strict";

const TABLE = "manual_admin_activities";
const LEGACY_INDEX = "maa_event_id_uq";

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(TABLE))) return;

    const [index, constraint] = await Promise.all([
      knex("pg_indexes")
        .where({
          schemaname: knex.raw("current_schema()"),
          tablename: TABLE,
          indexname: LEGACY_INDEX,
        })
        .first("indexname"),
      knex("pg_constraint").where({ conname: LEGACY_INDEX }).first("conname"),
    ]);

    // Earlier local iterations created a standalone unique index using the same
    // naming convention Strapi reserves for constraints. Remove only that index;
    // the content-type schema creates/retains the canonical eventId unique
    // constraint during the immediately following schema synchronization.
    if (index && !constraint) {
      await knex.raw(`DROP INDEX IF EXISTS ${LEGACY_INDEX}`);
    }
  },

  // Forward-only. Reverting uniqueness alignment could make the next boot fail.
  async down() {},
};
