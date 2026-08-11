"use strict";

/** Durable, future-only state for asynchronous Anipo barcode issuance. */
const LOCK_KEY = 827453110;
const TABLE = "orders";
const COLUMNS = [
  ["anipo_barcode_state", (table) => table.string("anipo_barcode_state", 32).nullable()],
  ["anipo_submitted_at", (table) => table.datetime("anipo_submitted_at").nullable()],
  ["anipo_last_checked_at", (table) => table.datetime("anipo_last_checked_at").nullable()],
  ["anipo_polling_deadline_at", (table) => table.datetime("anipo_polling_deadline_at").nullable()],
  ["anipo_issued_at", (table) => table.datetime("anipo_issued_at").nullable()],
  ["anipo_check_count", (table) => table.integer("anipo_check_count").notNullable().defaultTo(0)],
  ["anipo_ready_to_issue", (table) => table.boolean("anipo_ready_to_issue").nullable()],
  ["anipo_provider_status", (table) => table.string("anipo_provider_status", 255).nullable()],
  ["anipo_last_message", (table) => table.text("anipo_last_message").nullable()],
  ["anipo_last_error", (table) => table.text("anipo_last_error").nullable()],
];

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable(TABLE))) return;

    for (const [name, add] of COLUMNS) {
      if (!(await knex.schema.hasColumn(TABLE, name))) {
        await knex.schema.alterTable(TABLE, add);
      }
    }

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_orders_anipo_barcode_pending
      ON orders (anipo_last_checked_at, id)
      WHERE anipo_barcode_state = 'Pending'
    `);
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    await knex.raw("DROP INDEX IF EXISTS idx_orders_anipo_barcode_pending");
    if (!(await knex.schema.hasTable(TABLE))) return;
    for (const [name] of [...COLUMNS].reverse()) {
      if (await knex.schema.hasColumn(TABLE, name)) {
        await knex.schema.alterTable(TABLE, (table) => table.dropColumn(name));
      }
    }
  },

  __private: { LOCK_KEY, TABLE, COLUMNS },
};
