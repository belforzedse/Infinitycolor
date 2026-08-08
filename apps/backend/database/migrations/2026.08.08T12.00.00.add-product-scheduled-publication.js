/**
 * Migration: scheduled product publication fields.
 *
 * Products use Status Active|InActive|Scheduled (draftAndPublish is false).
 * Scheduled rows stay out of public Status=Active queries until the worker publishes.
 */

module.exports = {
  async up(knex) {
    const hasScheduledPublishAt = await knex.schema.hasColumn("products", "scheduled_publish_at");
    if (!hasScheduledPublishAt) {
      await knex.schema.alterTable("products", (table) => {
        table.datetime("scheduled_publish_at");
        table.string("scheduled_publish_timezone");
        table.boolean("scheduled_publish_require_media").defaultTo(true);
        table.datetime("scheduled_publish_last_attempt_at");
        table.string("scheduled_publish_last_error");
      });
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
      ON products (scheduled_publish_at)
      WHERE scheduled_publish_at IS NOT NULL
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
        table.dropColumn("scheduled_publish_last_attempt_at");
        table.dropColumn("scheduled_publish_last_error");
      });
    }
  },
};
