"use strict";

/**
 * Migration: product Trash lifecycle columns.
 *
 * Backs the schema.json fields read by `services/product-lifecycle.ts`:
 *   removed_by_id / removed_by_label          — who moved the product to Trash
 *   pre_removal_status / _scheduled_publish_at — the publication state it left
 *   purged_at / purged_by_id                   — permanent deletion (tombstone)
 *
 * Additive only. Existing trashed rows are deliberately not rewritten: code reads
 * their previous status as COALESCE(pre_removal_status, status). The lifecycle
 * indexes are declared in schema.json, so Strapi's sync creates and owns them.
 * Schema sync alone is not trusted to land columns on prod (see the 2026.09.06
 * schema-drift repairs), so they are created explicitly and idempotently here.
 */

const TABLE = "products";
const LOCK_KEY = 827453119;

const COLUMNS = [
  ["removed_by_id", (table) => table.integer("removed_by_id")],
  ["removed_by_label", (table) => table.string("removed_by_label")],
  ["pre_removal_status", (table) => table.string("pre_removal_status")],
  ["pre_removal_scheduled_publish_at", (table) => table.datetime("pre_removal_scheduled_publish_at")],
  ["purged_at", (table) => table.datetime("purged_at")],
  ["purged_by_id", (table) => table.integer("purged_by_id")],
];

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable(TABLE))) {
      console.warn(
        `Skipping product trash lifecycle migration because ${TABLE} does not exist yet. Strapi schema sync will create the fields.`,
      );
      return;
    }

    for (const [column, add] of COLUMNS) {
      if (!(await knex.schema.hasColumn(TABLE, column))) {
        await knex.schema.alterTable(TABLE, add);
      }
    }
  },

  // Forward-only: rollback must not discard who trashed or purged a product.
  async down() {},
};
