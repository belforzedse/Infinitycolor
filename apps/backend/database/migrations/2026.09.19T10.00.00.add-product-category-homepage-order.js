"use strict";

const TABLE = "product_categories";
const COLUMN = "homepage_order";
const DEFAULT_ORDER = 1000;
const LOCK_KEY = 719_204_573;

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable(TABLE))) return;

    if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
      await knex.schema.alterTable(TABLE, (table) => {
        table.integer(COLUMN).notNullable().defaultTo(DEFAULT_ORDER);
      });
    }

    // Establish the requested initial RTL reading order. All other categories
    // keep the shared default and use the storefront's title fallback.
    await knex(TABLE)
      .where({ title: "شومیز" })
      .update({ [COLUMN]: 1 });
    await knex(TABLE)
      .where({ title: "شلوار" })
      .update({ [COLUMN]: 2 });
  },

  async down() {
    // Preserve curated homepage order values across application rollbacks.
  },

  __private: { TABLE, COLUMN, DEFAULT_ORDER, LOCK_KEY },
};
