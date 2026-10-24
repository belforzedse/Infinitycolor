"use strict";

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [827453140]);
    if (!(await knex.schema.hasTable("orders"))) return;
    for (const column of [
      "shipping_sms_due_at",
      "shipping_sms_completed_at",
      "shipping_sms_last_attempt_at",
    ]) {
      if (!(await knex.schema.hasColumn("orders", column))) {
        await knex.schema.alterTable("orders", (table) => {
          table.timestamp(column, { useTz: true }).nullable();
        });
      }
    }
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_orders_shipping_sms_due
      ON orders (status, shipping_sms_completed_at, shipping_sms_due_at)`);
  },
  // Preserve scheduled notifications through application rollback. Historical
  // orders are deliberately not backfilled: their SMS may already have sent.
  async down() {},
};
