"use strict";

/**
 * Migration: products.published_at.
 *
 * Backs the schema.json `PublishedAt` field (see product-card-query.ts's
 * "newest" sort fallback chain). Schema-sync alone is not trusted to land this
 * on prod (see the 2026.09.06/2026.09.01 schema-drift repair migrations), so
 * the column is created explicitly and idempotently here.
 */

const TABLE = "products";
const COLUMN = "published_at";

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(TABLE))) {
      console.warn(
        `Skipping ${COLUMN} migration because ${TABLE} table does not exist yet. Strapi schema sync will create the field.`,
      );
      return;
    }
    if (await knex.schema.hasColumn(TABLE, COLUMN)) return;

    await knex.schema.alterTable(TABLE, (table) => {
      table.datetime(COLUMN);
    });
  },

  async down() {
    // Preserve go-live history on rollback.
  },
};
