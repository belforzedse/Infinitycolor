/**
 * Removes manually managed partial UNIQUE indexes from Strapi-owned tables.
 *
 * Strapi introspects these indexes during schema synchronization, classifies
 * them as constraints, and tries to remove them with:
 *
 *   ALTER TABLE ... DROP CONSTRAINT <index name>
 *
 * PostgreSQL rejects that command because a partial unique index is not a table
 * constraint, leaving every web container in a restart loop. Application
 * migrations run before schema synchronization, so this repair must remain a
 * separate forward migration for databases that already persisted the indexes.
 *
 * The two globally unique identifiers are reasserted after schema sync as real
 * table constraints by `ensureSnappayDatabaseInvariants`. Provider-reference
 * guards are reasserted as expression-only indexes that Strapi's inspector does
 * not misclassify, and the non-unique recovery indexes are retained.
 */
const SNAPPAY_MIGRATION_LOCK_KEY = 827453100;

const STRAPI_CONFLICTING_INDEXES = [
  "idx_payment_attempts_attempt_id",
  "idx_payment_attempts_snappay_transaction",
  "idx_contract_transactions_snappay_transaction",
  "idx_payment_operations_idempotency_key",
];

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [SNAPPAY_MIGRATION_LOCK_KEY]);

    for (const indexName of STRAPI_CONFLICTING_INDEXES) {
      await knex.raw(`DROP INDEX IF EXISTS "${indexName}"`);
    }
  },

  async down() {
    // Intentionally irreversible: recreating these indexes restores the Strapi
    // boot-loop condition this migration repairs.
  },
};
