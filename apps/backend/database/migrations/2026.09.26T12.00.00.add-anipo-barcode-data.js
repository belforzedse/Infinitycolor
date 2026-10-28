"use strict";

/** Preserve every parcel barcode while keeping ShippingBarcode for older readers. */
module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [827453110]);
    if (!(await knex.schema.hasTable("orders"))) return;
    if (!(await knex.schema.hasColumn("orders", "anipo_barcode_data"))) {
      await knex.schema.alterTable("orders", (table) => {
        table.jsonb("anipo_barcode_data").nullable();
      });
    }
  },

  // Forward-only: rollback must not discard issued tracking codes.
  async down() {},
};
