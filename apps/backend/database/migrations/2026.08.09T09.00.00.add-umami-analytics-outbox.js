"use strict";

/**
 * Durable, provider-neutral analytics delivery ledger.
 *
 * Commerce remains authoritative. A successful settlement/refund records one
 * outbox row adjacent to that state transition; a maintenance worker delivers
 * the row to Umami and retries it independently. The unique key is deliberate:
 * a replayed gateway callback or repair sweep can never create a second
 * purchase/refund event for the same commerce source.
 */

const LOCK_KEY = 827453105;

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);

    if (!(await knex.schema.hasTable("analytics_outbox"))) {
      await knex.schema.createTable("analytics_outbox", (table) => {
        table.bigIncrements("id").primary();
        table.string("website_id", 160).notNullable();
        table.string("event_type", 64).notNullable();
        table.string("source_type", 96).notNullable();
        table.string("source_id", 160).notNullable();
        table.jsonb("payload").notNullable();
        table.string("status", 24).notNullable().defaultTo("pending");
        table.integer("attempt_count").notNullable().defaultTo(0);
        table.timestamp("available_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.timestamp("processing_started_at", { useTz: true }).nullable();
        table.timestamp("sent_at", { useTz: true }).nullable();
        table.timestamp("dead_lettered_at", { useTz: true }).nullable();
        table.text("last_error").nullable();
        table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.unique(["website_id", "event_type", "source_type", "source_id"], {
          indexName: "uq_analytics_outbox_source",
        });
        table.check(
          "status IN ('pending', 'processing', 'sent', 'dead_letter')",
          [],
          "analytics_outbox_status",
        );
      });
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS idx_analytics_outbox_due
         ON analytics_outbox (status, available_at, id)`,
      );
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS idx_analytics_outbox_source
         ON analytics_outbox (source_type, source_id)`,
      );
    }

    if (await knex.schema.hasTable("orders")) {
      const hasCorrelation = await knex.schema.hasColumn("orders", "analytics_correlation_id");
      if (!hasCorrelation) {
        await knex.schema.alterTable("orders", (table) => {
          table.string("analytics_correlation_id", 160).nullable();
        });
        await knex.raw(
          `CREATE INDEX IF NOT EXISTS idx_orders_analytics_correlation
           ON orders (analytics_correlation_id)`,
        );
      }
    }
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    await knex.schema.dropTableIfExists("analytics_outbox");
    if (await knex.schema.hasTable("orders")) {
      const hasCorrelation = await knex.schema.hasColumn("orders", "analytics_correlation_id");
      if (hasCorrelation) {
        await knex.schema.alterTable("orders", (table) => {
          table.dropColumn("analytics_correlation_id");
        });
      }
    }
  },
};
