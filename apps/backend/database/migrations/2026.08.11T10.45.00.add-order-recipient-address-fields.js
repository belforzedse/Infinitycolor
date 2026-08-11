"use strict";

/**
 * Preserve the recipient snapshot on an order address. WooCommerce shipping
 * recipients can differ from the account owner, so Anipo must not infer these
 * values only from the current user profile.
 */

const LOCK_KEY = 827453108;
const TABLE = "local_user_addresses";
const COLUMNS = [
  ["full_name", (table) => table.string("full_name", 255).nullable()],
  ["phone", (table) => table.string("phone", 32).nullable()],
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
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable(TABLE))) return;
    for (const [name] of [...COLUMNS].reverse()) {
      if (await knex.schema.hasColumn(TABLE, name)) {
        await knex.schema.alterTable(TABLE, (table) => table.dropColumn(name));
      }
    }
  },

  __private: { LOCK_KEY, TABLE, COLUMNS },
};
