"use strict";

/**
 * Daily Matomo <-> Strapi commerce reconciliation snapshots
 * (docs/analytics/analytics-architecture.md, docs/analytics/analytics-decisions.md D10).
 *
 * One row per Tehran-local day: Strapi's authoritative eligible-order count/revenue
 * for that day, alongside what Matomo reported for the same window (nullable —
 * Matomo can be unconfigured or unreachable without failing the job). This is a
 * data-health signal, not a ledger: Matomo undercounts by design (consent denial,
 * ad-blockers, best-effort fire-and-forget tracking) and never decrements its order
 * count for a later refund, so exact equality is not the expected steady state —
 * see `reconcile/commerceReconciliation.ts` for how the divergence is interpreted.
 *
 * Purely additive and reversible. Advisory-locked like every other migration in
 * this series (distinct key from SNAPPAY_MIGRATION_LOCK_KEY 827453100,
 * ANIPO_LOCATION_MIGRATION_LOCK_KEY 827453101, ANALYTICS_MIGRATION_LOCK_KEY
 * 827453102).
 */

const ANALYTICS_RECONCILIATION_MIGRATION_LOCK_KEY = 827453103;

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [
      ANALYTICS_RECONCILIATION_MIGRATION_LOCK_KEY,
    ]);

    if (!(await knex.schema.hasTable("analytics_reconciliation_daily"))) {
      await knex.schema.createTable("analytics_reconciliation_daily", (table) => {
        table.date("bucket_date").primary();
        table.bigInteger("strapi_orders").notNullable().defaultTo(0);
        table.bigInteger("strapi_gross_toman").notNullable().defaultTo(0);
        table.bigInteger("strapi_net_toman").notNullable().defaultTo(0);
        // Nullable: Matomo may be unconfigured, unreachable, or return an error —
        // that is a distinct, recorded state ("matomo_unavailable"), not a zero.
        table.bigInteger("matomo_orders").nullable();
        table.bigInteger("matomo_revenue").nullable();
        table.bigInteger("orders_delta").nullable();
        table.decimal("revenue_ratio", 10, 4).nullable();
        table.boolean("possible_currency_mismatch").notNullable().defaultTo(false);
        table.string("status", 24).notNullable();
        table.timestamp("computed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.check(
          "status IN ('matched', 'diverged', 'matomo_unavailable')",
          [],
          "analytics_reconciliation_daily_status",
        );
      });
      console.log("Added analytics_reconciliation_daily table");
    }
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [
      ANALYTICS_RECONCILIATION_MIGRATION_LOCK_KEY,
    ]);
    await knex.schema.dropTableIfExists("analytics_reconciliation_daily");
  },
};
