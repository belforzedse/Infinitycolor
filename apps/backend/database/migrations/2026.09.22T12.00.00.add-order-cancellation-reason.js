"use strict";

/**
 * Migration: orders.cancellation_reason.
 *
 * Backs the schema.json `CancellationReason` field. Without it, every
 * automated cancellation path (SnappPay, Saman, Mellat, ZarinPal, admin-cancel)
 * had no field to record why an order was cancelled, so the customer-facing
 * SMS/timeline text always fell back to a generic "cancelled by support"
 * message even when no human touched the order. Schema-sync alone is not
 * trusted to land this on prod (see the 2026.09.15 add-published-at and
 * 2026.09.06/2026.09.01 schema-drift repair migrations), so the column is
 * created explicitly and idempotently here.
 */

const LOCK_KEY = 827453114;
const TABLE = "orders";
const COLUMN = "cancellation_reason";

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable(TABLE))) return;
    if (await knex.schema.hasColumn(TABLE, COLUMN)) return;

    await knex.schema.alterTable(TABLE, (table) => {
      table.text(COLUMN).nullable();
    });
  },

  async down() {
    // No-op deliberately: this DB has no backups/PITR, and the entire point of
    // this migration is to stop losing why an order was cancelled — a rollback
    // that drops the column would destroy exactly the data it exists to keep.
  },

  __private: { LOCK_KEY, TABLE, COLUMN },
};
