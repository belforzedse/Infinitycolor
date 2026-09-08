"use strict";

const TABLE = "issue_reports";
const LOCK_KEY = 948_371_205;

async function assertUnique(knex, column, label) {
  const duplicate = await knex(TABLE)
    .select(column)
    .count("* as count")
    .whereNotNull(column)
    .groupBy(column)
    .havingRaw("COUNT(*) > 1")
    .first();
  if (duplicate) {
    throw new Error(`Issue report storage refused duplicate ${label} values`);
  }
}

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable(TABLE))) return;

    await assertUnique(knex, "public_id", "public ID");
    await assertUnique(knex, "submission_id", "submission ID");
    await knex.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_issue_reports_public_id ON ${TABLE} (public_id)`,
    );
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_issue_reports_submission_id ON ${TABLE} (submission_id)`,
    );
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_issue_reports_created_id ON ${TABLE} (created_at DESC, id DESC)`,
    );
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_issue_reports_status_created_id ON ${TABLE} (status, created_at DESC, id DESC)`,
    );
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_issue_reports_contact_prefix ON ${TABLE} (contact_number text_pattern_ops)`,
    );
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_issue_reports_issue_name_trgm ON ${TABLE} USING gin (issue_name gin_trgm_ops)`,
    );
  },

  async down(knex) {
    await knex.raw("DROP INDEX IF EXISTS idx_issue_reports_issue_name_trgm");
    await knex.raw("DROP INDEX IF EXISTS idx_issue_reports_status_created_id");
    await knex.raw("DROP INDEX IF EXISTS idx_issue_reports_created_id");
    await knex.raw("DROP INDEX IF EXISTS idx_issue_reports_contact_prefix");
    // Keep both uniqueness protections and all submitted reports on rollback.
  },
};
