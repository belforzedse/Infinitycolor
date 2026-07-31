/**
 * Drops the SnappPay payment-token encryption introduced by an earlier revision
 * of `2026.07.27T12.00.00.harden-snappay-payments`.
 *
 * That revision moved the provider token out of `contract_transactions.track_id`
 * into `payment_token_ciphertext` (AES-256-GCM) plus a keyed `payment_token_hash`
 * carrying a UNIQUE partial index. Three problems came with it:
 *
 *  - the fingerprint was HMAC'd with the *encryption key*, so rotating the key
 *    changed the hash while a unique index still depended on it;
 *  - a single duplicate hash made `ensureSnappayDatabaseInvariants` throw during
 *    bootstrap, crash-looping every web instance;
 *  - the token is not exploitable without our OAuth credentials anyway, and
 *    operators need it verbatim for SnappPay support tickets.
 *
 * No decryption is attempted. This application has never served production
 * traffic, so any ciphertext present belongs to throwaway staging records; the
 * token is re-issued by the provider on the next checkout. Dropping the columns
 * is sufficient. This migration is a no-op on databases that never ran the
 * encrypting revision.
 */
/** Must match the key used by `harden-snappay-payments` and snappay-database.ts. */
const SNAPPAY_MIGRATION_LOCK_KEY = 827453100;

module.exports = {
  async up(knex) {
    // Same reasoning as the migration this one follows: six instances boot at
    // once, and concurrent DDL on these tables must not interleave.
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [SNAPPAY_MIGRATION_LOCK_KEY]);

    await knex.raw("DROP INDEX IF EXISTS idx_contract_transactions_snappay_token_hash");

    const dropColumnsIfPresent = async (table, columns) => {
      if (!(await knex.schema.hasTable(table))) return;
      const present = [];
      for (const name of columns) {
        if (await knex.schema.hasColumn(table, name)) present.push(name);
      }
      if (present.length === 0) return;
      await knex.schema.alterTable(table, (t) => {
        t.dropColumns(...present);
      });
    };

    await dropColumnsIfPresent("contract_transactions", [
      "payment_token_ciphertext",
      "payment_token_hash",
      "payment_token_key_version",
    ]);
    await dropColumnsIfPresent("payment_attempts", ["callback_nonce_ciphertext"]);
  },

  async down() {
    // Intentionally irreversible: restoring these columns would reintroduce the
    // key material and the unique index this migration exists to remove.
  },
};
