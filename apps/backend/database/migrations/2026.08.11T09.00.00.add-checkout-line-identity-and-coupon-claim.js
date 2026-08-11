"use strict";

/**
 * Migration: durable checkout-line identity and limited-coupon claim.
 *
 * Three additive, nullable columns on existing Strapi content types (so nothing needs
 * to be registered in `core_persisted_tables` — that retention list only covers tables
 * with no content type behind them):
 *
 *   order_items.source_cart_item_id
 *     Which cart line an order line consumed. Post-payment cart cleanup used to call
 *     clearCart(userId) and wipe whatever was in the cart at callback time, including
 *     items added after checkout. SKU identity alone cannot distinguish "the line this
 *     order consumed" from "a new line for the same SKU", so the source id is recorded.
 *
 *   orders.cart_cleanup_completed_at
 *     Idempotency marker for that cleanup. Claimed and applied in one transaction, so a
 *     retry is either a complete no-op or a complete apply, never a partial re-consume.
 *     NULL on a paid order is the durable, sweepable "cleanup still owed" signal.
 *
 *   orders.discount_usage_claimed_discount_id
 *     Which discount row this order holds one usage of. Limited coupons are now claimed
 *     with a guarded UPDATE inside the same transaction that makes the discounted order
 *     and its contract amount durable, instead of being counted at settlement.
 *
 * All three are nullable with no default, so existing rows are untouched and no backfill
 * is required. A pre-migration order keeps source_cart_item_id NULL (which is exactly
 * what excludes it from the cleanup sweep) and discount_usage_claimed_discount_id NULL
 * (which keeps its settlement-time coupon increment behavior unchanged).
 */

// Next free key in the project's 8274531xx advisory-lock range.
const LOCK_KEY = 827453107;

const ORDER_COLUMNS = [
  ["discount_usage_claimed_discount_id", (table) => table.integer("discount_usage_claimed_discount_id")],
  ["cart_cleanup_completed_at", (table) => table.datetime("cart_cleanup_completed_at")],
];

async function addColumns(knex, tableName, columns) {
  if (!(await knex.schema.hasTable(tableName))) {
    console.warn(
      `Skipping ${tableName} columns: table does not exist yet. Strapi schema sync will create them from the content-type schema.`,
    );
    return;
  }
  for (const [column, add] of columns) {
    if (!(await knex.schema.hasColumn(tableName, column))) {
      await knex.schema.alterTable(tableName, add);
    }
  }
}

async function dropColumns(knex, tableName, columnNames) {
  if (!(await knex.schema.hasTable(tableName))) return;
  for (const column of columnNames) {
    if (await knex.schema.hasColumn(tableName, column)) {
      await knex.schema.alterTable(tableName, (table) => table.dropColumn(column));
    }
  }
}

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);

    await addColumns(knex, "order_items", [
      ["source_cart_item_id", (table) => table.integer("source_cart_item_id")],
    ]);
    await addColumns(knex, "orders", ORDER_COLUMNS);

    // Supports the cleanup reconciliation sweep, which looks for paid orders whose
    // cleanup has not completed. Partial so it stays small: completed orders, which are
    // the overwhelming majority, are not indexed at all.
    if (await knex.schema.hasColumn("orders", "cart_cleanup_completed_at")) {
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS idx_orders_cart_cleanup_pending
         ON orders (id)
         WHERE cart_cleanup_completed_at IS NULL`,
      );
    }
    if (await knex.schema.hasColumn("orders", "discount_usage_claimed_discount_id")) {
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS idx_orders_discount_usage_claim
         ON orders (discount_usage_claimed_discount_id)
         WHERE discount_usage_claimed_discount_id IS NOT NULL`,
      );
    }
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);

    await knex.raw("DROP INDEX IF EXISTS idx_orders_cart_cleanup_pending");
    await knex.raw("DROP INDEX IF EXISTS idx_orders_discount_usage_claim");
    await dropColumns(knex, "orders", ORDER_COLUMNS.map(([column]) => column));
    await dropColumns(knex, "order_items", ["source_cart_item_id"]);
  },

  __private: { LOCK_KEY, ORDER_COLUMNS },
};
