"use strict";

/**
 * `woocommerce_sync_items.status` gains the terminal value `excluded`.
 *
 * A WooCommerce order with zero line items and a zero total is an artifact
 * (an emptied admin order), not a sale. Until now the importer reported it as
 * `failed` / `ORDER_ITEMS_EMPTY`, so every campaign retried it and every
 * reconciliation listed it as a missing order. `excluded` records the decision
 * durably: the row is never claimed again (`claimItems` only takes pending /
 * failed / stale-running rows) and reconciliation can report it as excluded
 * rather than missing. A later WooCommerce edit still flips the row back to
 * `pending` through the normal revision comparison in `observe()`, where it is
 * re-evaluated and, if still empty, excluded again.
 *
 * The CHECK constraint was created inline by
 * 2026.08.05T09.00.00.add-woocommerce-sync-control-plane.js under the name
 * `woocommerce_sync_items_status`. Postgres cannot widen a CHECK in place, so
 * it is dropped and re-added under the same name inside one transaction.
 * Idempotent: skipped when the constraint already allows `excluded`. The table
 * is not a Strapi content type, so schema sync never touches it.
 */
const LOCK_KEY = 719_204_559;
const CONSTRAINT = "woocommerce_sync_items_status";
const STATUSES = ["observed", "pending", "running", "completed", "failed", "quarantined", "excluded"];

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable("woocommerce_sync_items"))) return;

    // Matched by definition, not by name: dropping the wrong name would leave
    // the old constraint in place and still reject `excluded` while this
    // migration reported success.
    const existing = await knex.raw(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'woocommerce_sync_items'::regclass AND contype = 'c'`,
    );
    const statusChecks = (existing.rows || []).filter((row) => /\bstatus\b/.test(String(row.definition)));
    if (statusChecks.length > 0 && statusChecks.every((row) => /'excluded'/.test(String(row.definition)))) {
      return;
    }
    for (const row of statusChecks) {
      await knex.raw(`ALTER TABLE woocommerce_sync_items DROP CONSTRAINT ??`, [row.conname]);
    }
    const list = STATUSES.map((status) => `'${status}'`).join(", ");
    await knex.raw(
      `ALTER TABLE woocommerce_sync_items ADD CONSTRAINT ${CONSTRAINT} CHECK (status IN (${list}))`,
    );
  },

  // Forward-only: narrowing would fail on any row already marked excluded.
  async down() {},
};
