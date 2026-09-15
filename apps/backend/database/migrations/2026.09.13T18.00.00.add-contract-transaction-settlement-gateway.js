"use strict";

/**
 * `contract_transactions.settlement_gateway`: the channel that carried one
 * settlement leg.
 *
 * The WooCommerce importer writes one successful transaction per payment leg
 * of an order. A split payment has a `Wallet` leg (TeraWallet's negative fee
 * line) and a gateway leg (WooCommerce `total`), and an order completed at the
 * branch without an online payment carries `OffGateway`. The report layer
 * groups cash per gateway on this column and falls back to
 * `orders.payment_gateway` where it is NULL — every live checkout transaction.
 *
 * Declared as `SettlementGateway` on the content type; this migration exists
 * because production has been left without declared columns before
 * (2026.09.06 repair) and a report query must not depend on schema sync
 * having run. Idempotent through `hasColumn`.
 */
const LOCK_KEY = 719_204_571;
const TABLE = "contract_transactions";
const COLUMN = "settlement_gateway";

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable(TABLE))) return;
    if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
      await knex.schema.alterTable(TABLE, (table) => table.string(COLUMN, 255).nullable());
    }
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable(TABLE))) return;
    if (await knex.schema.hasColumn(TABLE, COLUMN)) {
      await knex.schema.alterTable(TABLE, (table) => table.dropColumn(COLUMN));
    }
  },

  __private: { LOCK_KEY, TABLE, COLUMN },
};
