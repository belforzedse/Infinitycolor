"use strict";

/**
 * Durable control plane for the external WooCommerce poller.
 * Redis/BullMQ is wake-up transport only; cursors, leases, items and campaigns
 * remain authoritative in PostgreSQL.
 */
module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable("woocommerce_sync_control"))) {
      await knex.schema.createTable("woocommerce_sync_control", (table) => {
        table.integer("id").primary();
        table.string("mode", 16).notNullable().defaultTo("shadow");
        table.timestamp("activated_at", { useTz: true }).nullable();
        table.string("reconciliation_run_id", 255).nullable();
        table.string("reconciliation_sha256", 64).nullable();
        table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.check("id = 1", [], "woocommerce_sync_control_singleton");
        table.check("mode IN ('disabled', 'shadow', 'active')", [], "woocommerce_sync_control_mode");
      });
      await knex("woocommerce_sync_control").insert({ id: 1, mode: "shadow" });
    }

    if (!(await knex.schema.hasTable("woocommerce_sync_cursors"))) {
      await knex.schema.createTable("woocommerce_sync_cursors", (table) => {
        table.string("source_type", 32).primary();
        table.timestamp("cursor_time", { useTz: true }).nullable();
        table.bigInteger("cursor_id").notNullable().defaultTo(0);
        table.integer("sweep_page").notNullable().defaultTo(1);
        table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      });
    }

    if (!(await knex.schema.hasTable("woocommerce_sync_leases"))) {
      await knex.schema.createTable("woocommerce_sync_leases", (table) => {
        table.string("name", 128).primary();
        table.string("owner", 255).notNullable();
        table.string("fencing_token", 64).notNullable();
        table.timestamp("lease_until", { useTz: true }).notNullable();
        table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      });
    }

    if (!(await knex.schema.hasTable("woocommerce_sync_items"))) {
      await knex.schema.createTable("woocommerce_sync_items", (table) => {
        table.bigIncrements("id").primary();
        table.string("source_type", 32).notNullable();
        table.bigInteger("source_id").notNullable();
        table.bigInteger("parent_source_id").nullable();
        table.string("source_revision_sha256", 64).notNullable();
        table.timestamp("source_modified_at", { useTz: true }).nullable();
        table.string("lane", 16).notNullable().defaultTo("hourly");
        table.string("status", 16).notNullable().defaultTo("pending");
        table.integer("attempts").notNullable().defaultTo(0);
        table.timestamp("next_attempt_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.string("last_error_code", 128).nullable();
        table.string("claim_fencing_token", 64).nullable();
        table.string("claimed_revision_sha256", 64).nullable();
        table.timestamp("claim_until", { useTz: true }).nullable();
        table.timestamp("first_seen_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.timestamp("last_seen_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.timestamp("completed_at", { useTz: true }).nullable();
        table.unique(["source_type", "source_id"], { indexName: "uq_woocommerce_sync_items_source" });
        table.index(["status", "lane", "next_attempt_at"], "idx_woocommerce_sync_items_due");
        table.check("lane IN ('immediate', 'hourly', 'campaign')", [], "woocommerce_sync_items_lane");
        table.check("status IN ('observed', 'pending', 'running', 'completed', 'failed', 'quarantined')", [], "woocommerce_sync_items_status");
      });
    }

    if (!(await knex.schema.hasTable("woocommerce_sync_campaigns"))) {
      await knex.schema.createTable("woocommerce_sync_campaigns", (table) => {
        table.bigIncrements("id").primary();
        table.string("campaign_key", 64).notNullable().unique();
        table.string("kind", 32).notNullable();
        table.string("status", 24).notNullable().defaultTo("pending");
        table.string("current_step", 64).nullable();
        table.string("fencing_token", 64).nullable();
        table.timestamp("scheduled_for", { useTz: true }).notNullable();
        table.timestamp("started_at", { useTz: true }).nullable();
        table.timestamp("finished_at", { useTz: true }).nullable();
        table.jsonb("metrics").notNullable().defaultTo("{}");
        table.string("last_error_code", 128).nullable();
        table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.check("status IN ('pending', 'running', 'completed', 'completed-with-exceptions', 'failed', 'missed')", [], "woocommerce_sync_campaigns_status");
      });
    }

    if (!(await knex.schema.hasTable("woocommerce_sync_metrics"))) {
      await knex.schema.createTable("woocommerce_sync_metrics", (table) => {
        table.bigIncrements("id").primary();
        table.string("stage", 64).notNullable();
        table.string("outcome", 32).notNullable();
        table.integer("duration_ms").notNullable().defaultTo(0);
        table.integer("item_count").notNullable().defaultTo(0);
        table.bigInteger("byte_count").notNullable().defaultTo(0);
        table.bigInteger("rss_bytes").nullable();
        table.bigInteger("heap_bytes").nullable();
        table.string("error_code", 128).nullable();
        table.jsonb("detail").notNullable().defaultTo("{}");
        table.timestamp("recorded_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.index(["stage", "recorded_at"], "idx_woocommerce_sync_metrics_stage_time");
      });
    }

    for (const [tableName, indexName] of [
      ["products", "uq_products_external_source_id"],
      ["product_variations", "uq_product_variations_external_source_id"],
      ["product_stocks", "uq_product_stocks_external_source_id"],
      ["orders", "uq_orders_external_source_id"],
      ["contracts", "uq_contracts_external_source_id"],
      ["order_items", "uq_order_items_external_source_id"],
      ["users", "uq_users_external_source_id"],
    ]) {
      if (!(await knex.schema.hasTable(tableName))) continue;
      const duplicates = await knex.raw(
        `SELECT external_source, external_id, COUNT(*) AS count
           FROM ??
          WHERE external_source IS NOT NULL AND external_id IS NOT NULL
          GROUP BY external_source, external_id
         HAVING COUNT(*) > 1
          LIMIT 1`,
        [tableName],
      );
      if (duplicates.rows.length > 0) {
        throw new Error(`Cannot create ${indexName}: duplicate external identity exists in ${tableName}`);
      }
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (external_source, external_id)
          WHERE external_source IS NOT NULL AND external_id IS NOT NULL`,
        [indexName, tableName],
      );
    }
  },

  async down(knex) {
    for (const indexName of [
      "uq_products_external_source_id",
      "uq_product_variations_external_source_id",
      "uq_product_stocks_external_source_id",
      "uq_orders_external_source_id",
      "uq_contracts_external_source_id",
      "uq_order_items_external_source_id",
      "uq_users_external_source_id",
    ]) {
      await knex.raw("DROP INDEX IF EXISTS ??", [indexName]);
    }
    for (const tableName of [
      "woocommerce_sync_metrics",
      "woocommerce_sync_campaigns",
      "woocommerce_sync_items",
      "woocommerce_sync_leases",
      "woocommerce_sync_cursors",
      "woocommerce_sync_control",
    ]) {
      if (await knex.schema.hasTable(tableName)) await knex.schema.dropTable(tableName);
    }
  },
};
