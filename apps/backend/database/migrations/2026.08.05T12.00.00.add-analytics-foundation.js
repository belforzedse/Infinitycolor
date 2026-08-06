"use strict";

/**
 * Foundation tables for the ecommerce analytics/reporting expansion
 * (docs/analytics/analytics-architecture.md).
 *
 * Zero rollups existed before this migration — every existing report computes live
 * from base tables per request, which cannot support cohort/RFM/lifecycle/funnel
 * reporting that needs point-in-time daily history. These three tables are the
 * minimal additive foundation:
 *
 *  - analytics_refresh_state: one row per rollup job, tracking a watermark so a run
 *    is idempotent and resumable (upsert-on-watermark, matching the pattern already
 *    used by the stock-reservation/reserve-order expiry jobs).
 *  - analytics_daily_sales: one row per Tehran-local day, the canonical eligible-
 *    order sales rollup (see src/api/report/analytics/metrics/catalog.ts).
 *  - analytics_product_daily: one row per (day, product_variation_id) for per-
 *    product trend/conversion reporting (Phase 3/4). `product_variation_id = 0` is
 *    the sentinel for a line whose variation was later deleted — Postgres treats
 *    NULL as distinct-per-row in a UNIQUE constraint, which would silently break
 *    idempotent upserts for exactly the deleted-variation edge case, so a 0
 *    sentinel is used instead of NULL (real Strapi autoincrement ids start at 1).
 *
 * All three are purely additive and reversible; no existing table or column is
 * touched. Advisory-locked like the SnappPay/Anipo migrations before it, because
 * every app instance runs migrations on boot and concurrent DDL on a fresh table
 * must not interleave.
 */

/** Distinct from SNAPPAY_MIGRATION_LOCK_KEY (827453100) and ANIPO_LOCATION_MIGRATION_LOCK_KEY (827453101). */
const ANALYTICS_MIGRATION_LOCK_KEY = 827453102;

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [ANALYTICS_MIGRATION_LOCK_KEY]);

    if (!(await knex.schema.hasTable("analytics_refresh_state"))) {
      await knex.schema.createTable("analytics_refresh_state", (table) => {
        table.string("source_type", 64).primary();
        table.timestamp("watermark", { useTz: true }).nullable();
        table.timestamp("last_run_at", { useTz: true }).nullable();
        table.string("last_status", 16).nullable();
        table.text("last_error").nullable();
        table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.check(
          "last_status IS NULL OR last_status IN ('success', 'failed', 'running')",
          [],
          "analytics_refresh_state_status",
        );
      });
      console.log("Added analytics_refresh_state table");
    }

    if (!(await knex.schema.hasTable("analytics_daily_sales"))) {
      await knex.schema.createTable("analytics_daily_sales", (table) => {
        table.date("bucket_date").primary();
        table.string("currency", 8).notNullable().defaultTo("Toman");
        table.bigInteger("gross_toman").notNullable().defaultTo(0);
        table.bigInteger("discounts_toman").notNullable().defaultTo(0);
        table.bigInteger("refunds_toman").notNullable().defaultTo(0);
        table.bigInteger("net_toman").notNullable().defaultTo(0);
        table.bigInteger("units").notNullable().defaultTo(0);
        table.bigInteger("eligible_orders").notNullable().defaultTo(0);
        table.bigInteger("total_orders").notNullable().defaultTo(0);
        table.timestamp("computed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      });
      console.log("Added analytics_daily_sales table");
    }

    if (!(await knex.schema.hasTable("analytics_product_daily"))) {
      await knex.schema.createTable("analytics_product_daily", (table) => {
        table.bigIncrements("id").primary();
        table.date("bucket_date").notNullable();
        table.integer("product_variation_id").notNullable().defaultTo(0);
        table.string("product_sku", 255).notNullable().defaultTo("");
        table.string("product_title", 255).notNullable().defaultTo("");
        table.bigInteger("units").notNullable().defaultTo(0);
        table.bigInteger("gross_toman").notNullable().defaultTo(0);
        table.bigInteger("discounts_toman").notNullable().defaultTo(0);
        table.bigInteger("refunds_toman").notNullable().defaultTo(0);
        table.bigInteger("orders_count").notNullable().defaultTo(0);
        table.timestamp("computed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.unique(["bucket_date", "product_variation_id", "product_sku"], {
          indexName: "uq_analytics_product_daily_grain",
        });
      });
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS idx_analytics_product_daily_bucket
         ON analytics_product_daily (bucket_date)`,
      );
      console.log("Added analytics_product_daily table");
    }
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [ANALYTICS_MIGRATION_LOCK_KEY]);
    await knex.schema.dropTableIfExists("analytics_product_daily");
    await knex.schema.dropTableIfExists("analytics_daily_sales");
    await knex.schema.dropTableIfExists("analytics_refresh_state");
  },
};
