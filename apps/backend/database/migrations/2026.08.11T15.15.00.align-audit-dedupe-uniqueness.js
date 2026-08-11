"use strict";

const TABLE = "manual_admin_activities";
const LEGACY_INDEX = "maa_dedupe_key_uq";

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

    if (index && !constraint) {
      await knex.raw(`DROP INDEX IF EXISTS ${LEGACY_INDEX}`);
    }
  },

  async down() {},
};
