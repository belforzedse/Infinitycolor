"use strict";

const LOOKUP_INDEX_NAME = "idx_products_active_slug_lookup";
const TRIGGER_NAME = "trg_products_active_slug_guard";
const FUNCTION_NAME = "enforce_products_active_slug_guard";

/**
 * WooCommerce permits draft/inactive products to share a slug with a published
 * product. Preserve source slugs exactly while keeping public routes unambiguous:
 * only active, non-removed, non-empty slugs must be unique.
 */
async function up(knex) {
  if (!(await knex.schema.hasTable("products"))) return;

  const duplicates = await knex("products")
    .select("slug")
    .count("id as count")
    .where("status", "Active")
    .whereNull("removed_at")
    .whereNotNull("slug")
    .whereNot("slug", "")
    .groupBy("slug")
    .havingRaw("COUNT(id) > 1")
    .limit(1);
  if (duplicates.length > 0) {
    throw new Error("PRODUCT_ACTIVE_SLUG_DUPLICATES_EXIST");
  }

  // Strapi's schema sync attempts to manage every unique index it discovers as
  // a table constraint. Use an ordinary partial lookup index and a trigger
  // instead. The advisory transaction lock serializes equal slugs so the
  // trigger remains race-safe without changing the exact WooCommerce value.
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS ${LOOKUP_INDEX_NAME}
     ON products (slug)
     WHERE status = 'Active' AND removed_at IS NULL AND slug IS NOT NULL AND slug <> ''`,
  );

  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.status = 'Active'
        AND NEW.removed_at IS NULL
        AND NEW.slug IS NOT NULL
        AND NEW.slug <> '' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.slug, 871953));

        IF EXISTS (
          SELECT 1
          FROM products AS existing
          WHERE existing.slug = NEW.slug
            AND existing.status = 'Active'
            AND existing.removed_at IS NULL
            AND existing.id IS DISTINCT FROM NEW.id
        ) THEN
          RAISE EXCEPTION 'PRODUCT_ACTIVE_SLUG_DUPLICATE'
            USING ERRCODE = '23505';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$
  `);

  await knex.raw(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON products`);
  await knex.raw(`
    CREATE TRIGGER ${TRIGGER_NAME}
    BEFORE INSERT OR UPDATE OF slug, status, removed_at ON products
    FOR EACH ROW
    EXECUTE FUNCTION ${FUNCTION_NAME}()
  `);
}

async function down(knex) {
  if (!(await knex.schema.hasTable("products"))) return;

  await knex.raw(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON products`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FUNCTION_NAME}()`);
  await knex.raw(`DROP INDEX IF EXISTS ${LOOKUP_INDEX_NAME}`);
}

module.exports = { down, up };
