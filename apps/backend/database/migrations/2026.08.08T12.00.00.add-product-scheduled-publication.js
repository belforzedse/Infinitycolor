/**
 * Migration: scheduled product publication fields.
 *
 * Products use Status Active|InActive|Scheduled (draftAndPublish is false).
 * Scheduled rows stay out of public Status=Active queries until the worker publishes.
 */

module.exports = {
  async up(knex) {
    const productsTableExists = await knex.schema.hasTable("products");
    if (!productsTableExists) {
      console.warn(
        "Skipping scheduled product publication migration because products table does not exist yet. Strapi schema sync will create the fields.",
      );
      return;
    }

    const hasScheduledPublishAt = await knex.schema.hasColumn("products", "scheduled_publish_at");
    if (!hasScheduledPublishAt) {
      await knex.schema.alterTable("products", (table) => {
        table.datetime("scheduled_publish_at");
        table.string("scheduled_publish_timezone");
        table.boolean("scheduled_publish_require_media").notNullable().defaultTo(false);
        table.integer("scheduled_publish_revision").notNullable().defaultTo(0);
        table.datetime("scheduled_publish_last_attempt_at");
        table.string("scheduled_publish_last_error");
        table.string("scheduled_publish_failure_kind");
        table.integer("scheduled_publish_attempt_count").notNullable().defaultTo(0);
        table.datetime("scheduled_publish_next_retry_at");
        table.integer("publication_revision").notNullable().defaultTo(0);
        table.integer("publication_effects_completed_revision").notNullable().defaultTo(0);
        table.string("publication_effects_last_error");
      });
    }

    // The initial dev migration existed before the reliability fields were
    // finalized. Add each column independently so an already-migrated staging
    // database upgrades safely without a destructive rollback/re-run.
    const additiveColumns = [
      ["scheduled_publish_at", (table) => table.datetime("scheduled_publish_at")],
      ["scheduled_publish_timezone", (table) => table.string("scheduled_publish_timezone")],
      ["scheduled_publish_require_media", (table) => table.boolean("scheduled_publish_require_media").notNullable().defaultTo(false)],
      ["scheduled_publish_revision", (table) => table.integer("scheduled_publish_revision").notNullable().defaultTo(0)],
      ["scheduled_publish_last_attempt_at", (table) => table.datetime("scheduled_publish_last_attempt_at")],
      ["scheduled_publish_last_error", (table) => table.string("scheduled_publish_last_error")],
      ["scheduled_publish_failure_kind", (table) => table.string("scheduled_publish_failure_kind")],
      ["scheduled_publish_attempt_count", (table) => table.integer("scheduled_publish_attempt_count").notNullable().defaultTo(0)],
      ["scheduled_publish_next_retry_at", (table) => table.datetime("scheduled_publish_next_retry_at")],
      ["publication_revision", (table) => table.integer("publication_revision").notNullable().defaultTo(0)],
      ["publication_effects_completed_revision", (table) => table.integer("publication_effects_completed_revision").notNullable().defaultTo(0)],
      ["publication_effects_last_error", (table) => table.string("publication_effects_last_error")],
    ];
    for (const [column, add] of additiveColumns) {
      if (!(await knex.schema.hasColumn("products", column))) {
        await knex.schema.alterTable("products", add);
      }
    }

    // Extend Status enum to include Scheduled when using Postgres.
    const client = knex.client.config.client;
    if (client === "postgres" || client === "pg") {
      try {
        await knex.raw(`
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM pg_type t
              JOIN pg_enum e ON t.oid = e.enumtypid
              WHERE t.typname = 'products_status_enum' AND e.enumlabel = 'Active'
            ) AND NOT EXISTS (
              SELECT 1 FROM pg_type t
              JOIN pg_enum e ON t.oid = e.enumtypid
              WHERE t.typname = 'products_status_enum' AND e.enumlabel = 'Scheduled'
            ) THEN
              ALTER TYPE products_status_enum ADD VALUE IF NOT EXISTS 'Scheduled';
            END IF;
          END
          $$;
        `);
      } catch (error) {
        // Strapi may store Status as varchar rather than a PG enum depending on version.
        console.warn(`[migration] scheduled status enum update skipped: ${error.message}`);
      }
    }

    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_products_scheduled_publish
      ON products (status, scheduled_publish_at)
      WHERE status = 'Scheduled' AND scheduled_publish_at IS NOT NULL
    `);
  },

  async down(knex) {
    await knex.raw(`DROP INDEX IF EXISTS idx_products_scheduled_publish`);
    const hasScheduledPublishAt = await knex.schema.hasColumn("products", "scheduled_publish_at");
    if (hasScheduledPublishAt) {
      await knex.schema.alterTable("products", (table) => {
        table.dropColumn("scheduled_publish_at");
        table.dropColumn("scheduled_publish_timezone");
        table.dropColumn("scheduled_publish_require_media");
        table.dropColumn("scheduled_publish_revision");
        table.dropColumn("scheduled_publish_last_attempt_at");
        table.dropColumn("scheduled_publish_last_error");
        table.dropColumn("scheduled_publish_failure_kind");
        table.dropColumn("scheduled_publish_attempt_count");
        table.dropColumn("scheduled_publish_next_retry_at");
        table.dropColumn("publication_revision");
        table.dropColumn("publication_effects_completed_revision");
        table.dropColumn("publication_effects_last_error");
      });
    }
  },
};
