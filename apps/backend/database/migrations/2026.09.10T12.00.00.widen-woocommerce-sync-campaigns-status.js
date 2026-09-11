"use strict";

/**
 * `woocommerce_sync_campaigns.status` was created as `varchar(24)`
 * (2026.08.05T09.00.00.add-woocommerce-sync-control-plane.js), but its own
 * CHECK constraint allows the value `completed-with-exceptions`, which is 25
 * characters. Every campaign that finished with per-record exceptions (the
 * normal, expected outcome for a WooCommerce import batch — see the catalog/
 * order exception counts this task's campaign produced) hit Postgres error
 * 22001 ("value too long for type character varying(24)") the instant
 * `finishCampaign` tried to persist that status, so the worker reported the
 * campaign as `failed` even though every stage had actually completed.
 *
 * The column width is independent of the CHECK constraint, so only the width
 * needs to change — `ALTER COLUMN ... TYPE varchar(32)` leaves the existing
 * `woocommerce_sync_campaigns_status` check and every row untouched. Widening
 * is idempotent: skipped entirely once the column is already >= 32 wide, so
 * this is safe to run again against an already-repaired database.
 *
 * This table is not backed by a Strapi content type (only its *existence* is
 * protected via core_persisted_tables in
 * 2026.08.06T09.00.00.persist-custom-database-tables.js), so Strapi's own
 * schema sync never inspects or diffs its columns — unlike the August
 * content-type drift incident, there is no sync pass that could revert this.
 */
const LOCK_KEY = 719_204_558;

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);

    if (!(await knex.schema.hasTable("woocommerce_sync_campaigns"))) return;

    const column = await knex("information_schema.columns")
      .select("character_maximum_length")
      .where({ table_name: "woocommerce_sync_campaigns", column_name: "status" })
      .first();
    if (!column || Number(column.character_maximum_length) >= 32) return;

    await knex.raw("ALTER TABLE woocommerce_sync_campaigns ALTER COLUMN status TYPE varchar(32)");
  },

  // Forward-only: a narrower column would immediately break on the next
  // completed-with-exceptions campaign this migration exists to fix.
  async down() {},
};
