"use strict";

// The post-sync bootstrap also asserts this expression index on a fresh database.
// An expression avoids Strapi misclassifying a partial column index as a constraint.
module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable("contract_transactions"))) return;
    const client = String(knex.client.config.client).toLowerCase();
    if (!client.includes("pg") && !client.includes("postgres")) return;
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_transactions_mellat_reference
      ON contract_transactions ((CASE
        WHEN lower(external_source) = 'mellat' AND type = 'Gateway' AND status = 'Success'
          AND external_id IS NOT NULL AND external_id <> '' THEN external_id ELSE NULL END))`);
  },
  async down() {
    // Financial uniqueness remains valid across application rollback.
  },
};
