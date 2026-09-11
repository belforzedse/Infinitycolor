"use strict";

/**
 * Re-promote audit rows that were wrongly stamped as schema_version=1 /
 * event_key=legacy.activity after Strapi schema sync wiped modern columns and
 * `2026.08.11T15.00.00.rebuild-admin-audit-events` backfilled them as legacy.
 *
 * Idempotent: only touches rows still marked legacy.activity at schema_version 1.
 * True pre-v2 history without a catalog/pattern title is left alone.
 */

// One inference table, owned by the rebuild migration. Sharing it is what keeps
// this repair and that backfill from disagreeing: anything this promotes, the
// backfill can no longer demote on a later schema-sync wipe.
const {
  __private: { inferredEventKeyOrNullSql, inferredDomainOperationOrNullSql },
} = require("./2026.08.11T15.00.00.rebuild-admin-audit-events.js");

const TABLE = "manual_admin_activities";
const LOCK_KEY = 827453113;
const APPEND_ONLY_TRIGGER = "manual_admin_activities_append_only";

function catalogTitleCaseSql() {
  return inferredEventKeyOrNullSql();
}

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable(TABLE))) return;
    if (!(await knex.schema.hasColumn(TABLE, "schema_version"))) return;
    if (!(await knex.schema.hasColumn(TABLE, "event_key"))) return;

    await knex.raw(`DROP TRIGGER IF EXISTS ${APPEND_ONLY_TRIGGER} ON ${TABLE}`);

    const mappedKey = catalogTitleCaseSql();

    await knex.raw(
      `UPDATE ${TABLE}
          SET schema_version = 2,
              event_key = ${mappedKey},
              -- Overwrite, do not COALESCE: the demoting backfill already filled
              -- these from resource_type/action ('product'/'create'), which the
              -- live writer never emits, so the report's domain filter listed the
              -- same events twice. The catalog value is not derivable from the key
              -- ('products.updated' is domain 'catalog').
              domain = COALESCE(${inferredDomainOperationOrNullSql(0)}, domain),
              operation = COALESCE(${inferredDomainOperationOrNullSql(1)}, operation),
              origin = CASE
                WHEN origin IS NULL OR origin = 'legacy' THEN 'admin_ui'
                ELSE origin
              END,
              search_text = trim(concat_ws(' ', performed_by_name, performed_by_role, resource_type,
                resource_id, title, message, message_en, ${mappedKey}, correlation_id,
                job_id, batch_id)),
              updated_at = NOW()
        WHERE schema_version = 1
          AND event_key = 'legacy.activity'
          AND (${mappedKey}) IS NOT NULL`,
    );

    await knex.raw(`
      CREATE OR REPLACE FUNCTION infinity_prevent_audit_event_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Audit events are append-only and cannot be updated or deleted.'
          USING ERRCODE = '55000';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS ${APPEND_ONLY_TRIGGER} ON ${TABLE};
      CREATE TRIGGER ${APPEND_ONLY_TRIGGER}
        BEFORE UPDATE OR DELETE ON ${TABLE}
        FOR EACH ROW EXECUTE FUNCTION infinity_prevent_audit_event_mutation();
    `);
  },

  async down() {},

  __private: { TABLE, catalogTitleCaseSql },
};
