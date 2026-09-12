"use strict";

const LOCK_KEY = 827453112;
const TABLE = "orders";
const INDEX = "idx_orders_anipo_recipient_sync_due";
const COLUMNS = [
  ["anipo_recipient_revision", (table) => table.integer("anipo_recipient_revision").notNullable().defaultTo(0)],
  ["anipo_recipient_synced_revision", (table) => table.integer("anipo_recipient_synced_revision").notNullable().defaultTo(0)],
  ["anipo_recipient_sync_state", (table) => table.string("anipo_recipient_sync_state", 32).nullable()],
  ["anipo_recipient_sync_attempts", (table) => table.integer("anipo_recipient_sync_attempts").notNullable().defaultTo(0)],
  ["anipo_recipient_sync_last_attempt_at", (table) => table.timestamp("anipo_recipient_sync_last_attempt_at", { useTz: true }).nullable()],
  ["anipo_recipient_sync_last_error", (table) => table.text("anipo_recipient_sync_last_error").nullable()],
  ["anipo_recipient_synced_at", (table) => table.timestamp("anipo_recipient_synced_at", { useTz: true }).nullable()],
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
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS ${INDEX}
       ON ${TABLE} (anipo_recipient_sync_state, anipo_recipient_sync_last_attempt_at, id)
       WHERE anipo_recipient_sync_state IN ('Pending', 'NeedsAttention')`,
    );
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable(TABLE))) return;
    await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
    for (const [name] of [...COLUMNS].reverse()) {
      if (await knex.schema.hasColumn(TABLE, name)) {
        await knex.schema.alterTable(TABLE, (table) => table.dropColumn(name));
      }
    }
  },

  __private: { LOCK_KEY, TABLE, INDEX, COLUMNS },
};
