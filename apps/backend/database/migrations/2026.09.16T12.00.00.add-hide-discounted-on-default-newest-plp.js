"use strict";

const SETTINGS_TABLE = "site_settings";
const COLUMN = "hide_discounted_on_default_newest_plp";

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(SETTINGS_TABLE))) return;
    if (await knex.schema.hasColumn(SETTINGS_TABLE, COLUMN)) return;

    await knex.schema.alterTable(SETTINGS_TABLE, (table) => {
      table.boolean(COLUMN).notNullable().defaultTo(false);
    });
  },

  async down() {
    // Preserve the toggle's state on rollback.
  },
};
