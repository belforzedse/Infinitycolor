"use strict";

/**
 * Trigram index for admin order search by shipping recipient.
 *
 * The orders list ILIKE-matches `local_user_addresses.full_name` (schema
 * `FullName`). Leading-wildcard ILIKE cannot use a btree; this is the same
 * `gin_trgm_ops` treatment already applied to FirstName/LastName/phone.
 *
 * `pg_trgm` may be missing on a managed instance. Skip the index rather than
 * failing the migration — search still works, just unindexed.
 *
 * Additive only. Column name is probed: Strapi stores unquoted `full_name`,
 * never quoted camelCase `"FullName"`.
 */

const LOCK_KEY = 918273812;

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable("local_user_addresses"))) return;

    let hasTrigram = false;
    try {
      await knex.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm");
      hasTrigram = true;
    } catch (error) {
      console.warn(
        `pg_trgm unavailable, skipping full_name trigram index: ${error.message}`,
      );
    }
    if (!hasTrigram) return;

    const columnResult = await knex.raw(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'local_user_addresses'
         AND column_name IN ('full_name', 'FullName')
       ORDER BY CASE WHEN column_name = 'full_name' THEN 0 ELSE 1 END
       LIMIT 1`,
    );
    const columnName = columnResult.rows?.[0]?.column_name;
    if (!columnName) {
      console.warn("✗ idx_local_user_addresses_full_name_trgm: no full_name column");
      return;
    }

    try {
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS idx_local_user_addresses_full_name_trgm
         ON local_user_addresses USING gin ("${columnName}" gin_trgm_ops)`,
      );
    } catch (error) {
      console.warn(`✗ idx_local_user_addresses_full_name_trgm: ${error.message}`);
    }
  },

  async down(knex) {
    await knex.raw("DROP INDEX IF EXISTS idx_local_user_addresses_full_name_trgm");
  },
};
