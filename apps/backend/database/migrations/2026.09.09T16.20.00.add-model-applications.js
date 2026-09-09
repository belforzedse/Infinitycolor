"use strict";

const TABLE = "model_applications";
const LOCK_KEY = 948_371_206;

async function assertUnique(knex, column, label) {
  const duplicate = await knex(TABLE)
    .select(column)
    .count("* as count")
    .whereNotNull(column)
    .groupBy(column)
    .havingRaw("COUNT(*) > 1")
    .first();
  if (duplicate) {
    throw new Error(`Model application storage refused duplicate ${label} values`);
  }
}

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable(TABLE))) return;

    await assertUnique(knex, "public_id", "public ID");
    await assertUnique(knex, "submission_id", "submission ID");
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_model_applications_public_id ON ${TABLE} (public_id)`,
    );
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_model_applications_submission_id ON ${TABLE} (submission_id)`,
    );
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_model_applications_created_id ON ${TABLE} (created_at DESC, id DESC)`,
    );
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_model_applications_status_created_id ON ${TABLE} (status, created_at DESC, id DESC)`,
    );
  },

  async down(knex) {
    await knex.raw("DROP INDEX IF EXISTS idx_model_applications_status_created_id");
    await knex.raw("DROP INDEX IF EXISTS idx_model_applications_created_id");
  },
};
