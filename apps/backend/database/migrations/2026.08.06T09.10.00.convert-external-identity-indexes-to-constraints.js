"use strict";

/**
 * Convert the WooCommerce partial unique indexes into named UNIQUE constraints.
 *
 * Strapi's PostgreSQL inspector reports both forms as `type: "unique"`, but its
 * schema builder drops that type with ALTER TABLE ... DROP CONSTRAINT. A partial
 * index therefore crashes schema synchronization whenever Strapi classifies it
 * as changed. PostgreSQL UNIQUE constraints retain the same identity semantics
 * here because NULL values remain distinct.
 */

const EXTERNAL_IDENTITY_MIGRATION_LOCK_KEY = 827453105;

const EXTERNAL_IDENTITY_CONSTRAINTS = Object.freeze([
  ["products", "uq_products_external_source_id"],
  ["product_variations", "uq_product_variations_external_source_id"],
  ["product_stocks", "uq_product_stocks_external_source_id"],
  ["orders", "uq_orders_external_source_id"],
  ["contracts", "uq_contracts_external_source_id"],
  ["order_items", "uq_order_items_external_source_id"],
  ["users", "uq_users_external_source_id"],
]);

async function constraintType(knex, tableName, constraintName) {
  const result = await knex.raw(
    `SELECT constraint_type
       FROM information_schema.table_constraints
      WHERE table_schema = current_schema()
        AND table_name = ?
        AND constraint_name = ?
      LIMIT 1`,
    [tableName, constraintName],
  );
  return result.rows[0]?.constraint_type ?? null;
}

async function indexExists(knex, tableName, indexName) {
  const result = await knex.raw(
    `SELECT 1
       FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = ?
        AND indexname = ?
      LIMIT 1`,
    [tableName, indexName],
  );
  return result.rows.length > 0;
}

async function hasDuplicateIdentity(knex, tableName) {
  const result = await knex.raw(
    `SELECT 1
       FROM ??
      WHERE external_source IS NOT NULL
        AND external_id IS NOT NULL
      GROUP BY external_source, external_id
     HAVING COUNT(*) > 1
      LIMIT 1`,
    [tableName],
  );
  return result.rows.length > 0;
}

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [EXTERNAL_IDENTITY_MIGRATION_LOCK_KEY]);

    for (const [tableName, constraintName] of EXTERNAL_IDENTITY_CONSTRAINTS) {
      if (!(await knex.schema.hasTable(tableName))) continue;
      if (
        !(await knex.schema.hasColumn(tableName, "external_source")) ||
        !(await knex.schema.hasColumn(tableName, "external_id"))
      ) {
        continue;
      }

      const existingConstraintType = await constraintType(knex, tableName, constraintName);
      if (existingConstraintType === "UNIQUE") continue;
      if (existingConstraintType) {
        throw new Error(
          `${constraintName} exists on ${tableName} as ${existingConstraintType}, not UNIQUE`,
        );
      }
      if (await hasDuplicateIdentity(knex, tableName)) {
        throw new Error(`Cannot create ${constraintName}: duplicate external identity exists`);
      }

      if (await indexExists(knex, tableName, constraintName)) {
        await knex.raw("DROP INDEX ??", [constraintName]);
      }
      await knex.raw(
        "ALTER TABLE ?? ADD CONSTRAINT ?? UNIQUE (external_source, external_id)",
        [tableName, constraintName],
      );
    }
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [EXTERNAL_IDENTITY_MIGRATION_LOCK_KEY]);

    for (const [tableName, constraintName] of EXTERNAL_IDENTITY_CONSTRAINTS) {
      if (!(await knex.schema.hasTable(tableName))) continue;
      if (
        !(await knex.schema.hasColumn(tableName, "external_source")) ||
        !(await knex.schema.hasColumn(tableName, "external_id"))
      ) {
        continue;
      }
      if ((await constraintType(knex, tableName, constraintName)) === "UNIQUE") {
        await knex.raw("ALTER TABLE ?? DROP CONSTRAINT ??", [tableName, constraintName]);
      }
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS ??
           ON ?? (external_source, external_id)
        WHERE external_source IS NOT NULL AND external_id IS NOT NULL`,
        [constraintName, tableName],
      );
    }
  },

  __private: {
    EXTERNAL_IDENTITY_CONSTRAINTS,
  },
};
