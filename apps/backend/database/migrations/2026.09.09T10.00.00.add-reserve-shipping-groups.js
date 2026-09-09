"use strict";

/**
 * The 48h combined-shipping hold: schema ownership notes + cleanup.
 *
 * The first version of this migration hand-built the relation schema:
 * `orders.reserve_shipment_id`, `reserve_groups.owner_id / root_order_id /
 * shipping_id / delivery_address_id`, plus indexes over them. That premise was
 * wrong. Strapi v4 does NOT store manyToOne/oneToOne as `<singular>_id` columns
 * on the owning table -- it stores every relation in a `<owner>_<attr>_links`
 * join table, and its boot-time schema sync DROPS any column on a managed table
 * that it cannot find in schema.json.
 *
 * So those columns were created here and silently reclaimed on the next boot,
 * taking their dependent indexes with them. Anything reading them failed at
 * runtime with 42703 -- see claimGroupShippingBarcode, which stamps the parcel
 * barcode onto member orders and now joins `orders_reserve_shipment_links`
 * instead. Re-running the old migration could never fix that; the columns just
 * got dropped again on the next restart.
 *
 * The table, its scalar columns, the link tables and the three indexes declared
 * in `reserve-group/schema.json` are all created by Strapi from that schema.
 * This migration therefore creates nothing. It only clears the leftovers from
 * v1 so no environment carries dead columns or stale indexes.
 *
 * The v1 backfill is gone too: it copied legacy `orders.reserve_group_id` values
 * into those same doomed columns, and there was never any legacy data to move --
 * the reserve feature shipped after the WooCommerce import, and no imported order
 * has ever carried a reserve_group_id.
 *
 * NOTE ON A LOST INVARIANT: v1 also tried to create
 * `uq_reserve_groups_owner_open`, a partial unique index enforcing one open
 * window per customer. It cannot be expressed as an index at all -- the owner is
 * in `reserve_groups_owner_links` while the state is on `reserve_groups`, and a
 * unique index cannot span two tables. That rule is enforced in application code
 * only, by findOpenGroupForUser at finalize. Restoring a database-level backstop
 * would mean denormalising the owner onto `reserve_groups` as a declared
 * attribute; that is a deliberate design change, not a migration fix.
 */

const LOCK_KEY = 918273645;
const TABLE = "reserve_groups";
const ORDERS = "orders";

/** Columns v1 added that Strapi does not know about and reclaims on boot. */
const DOOMED_GROUP_COLUMNS = [
  "owner_id",
  "root_order_id",
  "shipping_id",
  "delivery_address_id",
];

/** Indexes v1 created over those columns; they die with their columns. */
const DOOMED_INDEXES = [
  "idx_orders_reserve_shipment",
  "uq_reserve_groups_owner_open",
];

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);

    for (const name of DOOMED_INDEXES) {
      await knex.raw(`DROP INDEX IF EXISTS ${name}`);
    }

    if (await knex.schema.hasTable(ORDERS)) {
      if (await knex.schema.hasColumn(ORDERS, "reserve_shipment_id")) {
        await knex.schema.alterTable(ORDERS, (t) => t.dropColumn("reserve_shipment_id"));
      }
    }

    if (await knex.schema.hasTable(TABLE)) {
      for (const column of DOOMED_GROUP_COLUMNS) {
        if (await knex.schema.hasColumn(TABLE, column)) {
          await knex.schema.alterTable(TABLE, (t) => t.dropColumn(column));
        }
      }
    }
  },

  async down() {
    // Deliberately empty. Re-creating the dropped columns would recreate the
    // drift: Strapi's schema sync removes them again on the next boot.
  },

  __private: { LOCK_KEY, TABLE, ORDERS, DOOMED_GROUP_COLUMNS, DOOMED_INDEXES },
};
