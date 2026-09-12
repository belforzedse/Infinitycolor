"use strict";

const SETTINGS_TABLE = "site_settings";
const COLUMN = "home_favorite_product_ids";

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(SETTINGS_TABLE))) return;
    if (await knex.schema.hasColumn(SETTINGS_TABLE, COLUMN)) return;

    await knex.schema.alterTable(SETTINGS_TABLE, (table) => {
      table.jsonb(COLUMN).notNullable().defaultTo("[]");
    });
  },

  async down() {
    // Preserve curated homepage data on rollback.
  },
};
