"use strict";

/**
 * Give the 48h combined-shipping hold its own row.
 *
 * Before this, the whole feature lived on three `orders` columns, so there was
 * nothing to lock for the attach-vs-expire race and nowhere to record whether a
 * window ended by expiry or by an early release. Schema sync alone is not enough
 * here — production has previously drifted from declared-but-unmigrated columns,
 * so the table, its columns, its indexes and the backfill are all explicit.
 */

const LOCK_KEY = 918273645;
const TABLE = "reserve_groups";
const ORDERS = "orders";

const OPEN_STATES = ["PendingActivation", "Active"];

const COLUMNS = [
  ["group_key", (t) => t.string("group_key", 64).notNullable()],
  ["state", (t) => t.string("state", 32).notNullable().defaultTo("PendingActivation")],
  ["closure_reason", (t) => t.string("closure_reason", 32).nullable()],
  ["activated_at", (t) => t.datetime("activated_at").nullable()],
  ["expires_at", (t) => t.datetime("expires_at").nullable()],
  ["closed_at", (t) => t.datetime("closed_at").nullable()],
  ["last_order_attached_at", (t) => t.datetime("last_order_attached_at").nullable()],
  ["last_activity_at", (t) => t.datetime("last_activity_at").nullable()],
  ["shipping_cost_paid", (t) => t.integer("shipping_cost_paid").defaultTo(0)],
  ["shipping_method_code", (t) => t.string("shipping_method_code", 255).nullable()],
  ["shipping_method_title", (t) => t.string("shipping_method_title", 255).nullable()],
  ["shipping_barcode", (t) => t.string("shipping_barcode", 255).nullable()],
  ["created_at", (t) => t.datetime("created_at").nullable()],
  ["updated_at", (t) => t.datetime("updated_at").nullable()],
];

async function indexExists(knex, name) {
  const res = await knex.raw("SELECT to_regclass(?) AS reg", [`public.${name}`]);
  return Boolean(res?.rows?.[0]?.reg);
}

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);

    if (!(await knex.schema.hasTable(TABLE))) {
      await knex.schema.createTable(TABLE, (table) => {
        table.increments("id").primary();
      });
    }

    for (const [name, add] of COLUMNS) {
      if (!(await knex.schema.hasColumn(TABLE, name))) {
        await knex.schema.alterTable(TABLE, add);
      }
    }

    // Strapi manages relation columns as <singular>_id on the owning side.
    if (!(await knex.schema.hasColumn(TABLE, "owner_id"))) {
      await knex.schema.alterTable(TABLE, (t) => t.integer("owner_id").nullable());
    }
    if (!(await knex.schema.hasColumn(TABLE, "root_order_id"))) {
      await knex.schema.alterTable(TABLE, (t) => t.integer("root_order_id").nullable());
    }
    if (!(await knex.schema.hasColumn(TABLE, "shipping_id"))) {
      await knex.schema.alterTable(TABLE, (t) => t.integer("shipping_id").nullable());
    }
    if (!(await knex.schema.hasColumn(TABLE, "delivery_address_id"))) {
      await knex.schema.alterTable(TABLE, (t) =>
        t.integer("delivery_address_id").nullable()
      );
    }

    if (!(await knex.schema.hasColumn(ORDERS, "reserve_shipment_id"))) {
      // `reserve_group_id` is already taken by the legacy UUID string column
      // (attribute `reserveGroupId`), so the relation is named `reserve_shipment`
      // to avoid colliding with it.
      await knex.schema.alterTable(ORDERS, (t) =>
        t.integer("reserve_shipment_id").nullable()
      );
    }

    if (!(await indexExists(knex, "uq_reserve_groups_group_key"))) {
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_reserve_groups_group_key
           ON ${TABLE} (group_key)`
      );
    }
    if (!(await indexExists(knex, "idx_reserve_groups_state_expires"))) {
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS idx_reserve_groups_state_expires
           ON ${TABLE} (state, expires_at)`
      );
    }
    if (!(await indexExists(knex, "idx_orders_reserve_shipment"))) {
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS idx_orders_reserve_shipment
           ON ${ORDERS} (reserve_shipment_id)
         WHERE reserve_shipment_id IS NOT NULL`
      );
    }

    // One open consolidation window per customer. Partial so historical groups
    // never collide. Covers PendingActivation too: without it, two abandoned
    // reserve checkouts whose callbacks land late would collide at settlement.
    if (!(await indexExists(knex, "uq_reserve_groups_owner_open"))) {
      // DDL cannot take bind parameters through node-pg; inline the closed set.
      const openStatesSql = OPEN_STATES.map((state) => `'${state.replace(/'/g, "''")}'`).join(", ");
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_reserve_groups_owner_open
           ON ${TABLE} (owner_id)
         WHERE owner_id IS NOT NULL AND state IN (${openStatesSql})`
      );
    }

    // Backfill one group per historical reserve_group_id. Legacy rows cleared
    // is_reserve_order on expiry/release, so anything already cleared is closed;
    // the two outcomes were indistinguishable then and stay merged as Expired.
    await knex.raw(
      `INSERT INTO ${TABLE} (
         group_key, state, closure_reason, owner_id, root_order_id,
         expires_at, activated_at, closed_at, last_order_attached_at, last_activity_at,
         shipping_cost_paid, shipping_method_code, shipping_method_title,
         shipping_id, delivery_address_id, created_at, updated_at
       )
       SELECT
         src.reserve_group_id,
         CASE WHEN src.still_open THEN 'Active' ELSE 'ReadyToFulfill' END,
         CASE WHEN src.still_open THEN NULL ELSE 'Expired' END,
         src.owner_id,
         src.root_order_id,
         src.expires_at,
         src.first_date,
         CASE WHEN src.still_open THEN NULL ELSE src.last_updated END,
         src.last_date,
         COALESCE(src.last_updated, src.last_date),
         COALESCE(src.root_shipping_cost, 0),
         src.shipping_method_code,
         src.shipping_method_title,
         src.shipping_id,
         src.delivery_address_id,
         NOW(),
         NOW()
       FROM (
         SELECT DISTINCT ON (o.reserve_group_id)
           o.reserve_group_id,
           bool_or(o.is_reserve_order) OVER (PARTITION BY o.reserve_group_id) AS still_open,
           first_value(ul.user_id) OVER w AS owner_id,
           first_value(o.id) OVER w AS root_order_id,
           first_value(o.shipping_cost) OVER w AS root_shipping_cost,
           first_value(o.shipping_method_code) OVER w AS shipping_method_code,
           first_value(o.shipping_method_title) OVER w AS shipping_method_title,
           first_value(sl.shipping_id) OVER w AS shipping_id,
           first_value(dal.local_user_address_id) OVER w AS delivery_address_id,
           max(o.reserve_expires_at) OVER (PARTITION BY o.reserve_group_id) AS expires_at,
           min(o.date) OVER (PARTITION BY o.reserve_group_id) AS first_date,
           max(o.date) OVER (PARTITION BY o.reserve_group_id) AS last_date,
           max(o.updated_at) OVER (PARTITION BY o.reserve_group_id) AS last_updated
         FROM ${ORDERS} o
         LEFT JOIN orders_user_links ul ON ul.order_id = o.id
         LEFT JOIN orders_shipping_links sl ON sl.order_id = o.id
         LEFT JOIN orders_delivery_address_links dal ON dal.order_id = o.id
         WHERE o.reserve_group_id IS NOT NULL
         WINDOW w AS (PARTITION BY o.reserve_group_id ORDER BY o.date ASC, o.id ASC)
         ORDER BY o.reserve_group_id, o.date ASC, o.id ASC
       ) src
       ON CONFLICT (group_key) DO NOTHING`
    );

    await knex.raw(
      `UPDATE ${ORDERS} o
          SET reserve_shipment_id = g.id
         FROM ${TABLE} g
        WHERE o.reserve_group_id = g.group_key
          AND o.reserve_shipment_id IS NULL`
    );
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);

    if (await knex.schema.hasColumn(ORDERS, "reserve_shipment_id")) {
      await knex.raw("DROP INDEX IF EXISTS idx_orders_reserve_shipment");
      await knex.schema.alterTable(ORDERS, (t) => t.dropColumn("reserve_shipment_id"));
    }

    await knex.raw("DROP INDEX IF EXISTS uq_reserve_groups_owner_open");
    await knex.raw("DROP INDEX IF EXISTS idx_reserve_groups_state_expires");
    await knex.raw("DROP INDEX IF EXISTS uq_reserve_groups_group_key");

    if (await knex.schema.hasTable(TABLE)) {
      await knex.schema.dropTable(TABLE);
    }
  },

  __private: { LOCK_KEY, TABLE, ORDERS, COLUMNS, OPEN_STATES },
};
