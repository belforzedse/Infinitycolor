"use strict";

const TABLE = "product_category_contents";
const COLUMNS = [
  ["import_source", (table) => table.string("import_source", 255).nullable()],
  ["import_batch_id", (table) => table.string("import_batch_id", 255).nullable()],
  ["imported_source_hash", (table) => table.string("imported_source_hash", 64).nullable()],
  ["imported_at", (table) => table.timestamp("imported_at", { useTz: true }).nullable()],
];

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(TABLE))) return;
    for (const [column, define] of COLUMNS) {
      if (!(await knex.schema.hasColumn(TABLE, column))) {
        await knex.schema.alterTable(TABLE, (table) => define(table));
      }
    }
  },

  async down() {
    // Provenance is deliberately retained on rollback. An older application
    // image ignores these private additive columns, while dropping them would
    // erase the audit trail needed to validate or resume an import batch.
  },
};
