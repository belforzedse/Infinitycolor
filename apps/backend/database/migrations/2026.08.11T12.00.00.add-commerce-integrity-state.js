"use strict";

/** Additive state required for idempotent manual stock and wallet-topup recovery. */
const LOCK_KEY = 827453108;

async function addColumn(knex, tableName, columnName, add) {
  if (!(await knex.schema.hasTable(tableName))) return;
  if (!(await knex.schema.hasColumn(tableName, columnName))) {
    await knex.schema.alterTable(tableName, add);
  }
}

async function dropColumn(knex, tableName, columnName) {
  if (!(await knex.schema.hasTable(tableName))) return;
  if (await knex.schema.hasColumn(tableName, columnName)) {
    await knex.schema.alterTable(tableName, (table) => table.dropColumn(columnName));
  }
}

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);

    await addColumn(knex, "orders", "manual_stock_applied_at", (table) =>
      table.datetime("manual_stock_applied_at"),
    );
    await addColumn(knex, "wallet_topups", "next_reconcile_at", (table) =>
      table.datetime("next_reconcile_at"),
    );
    await addColumn(knex, "wallet_topups", "reconcile_attempts", (table) =>
      table.integer("reconcile_attempts").notNullable().defaultTo(0),
    );
    await addColumn(knex, "wallet_topups", "last_provider_code", (table) =>
      table.integer("last_provider_code"),
    );
    await addColumn(knex, "wallet_topups", "last_provider_error", (table) =>
      table.text("last_provider_error"),
    );

    const client = knex.client.config.client;
    if (client === "postgres" || client === "pg") {
      for (const value of ["Processing", "Unknown"]) {
        await knex.raw(`
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM pg_type WHERE typname = 'wallet_topups_status_enum'
            ) THEN
              ALTER TYPE wallet_topups_status_enum ADD VALUE IF NOT EXISTS '${value}';
            END IF;
          END
          $$;
        `);
      }
    }

    if (await knex.schema.hasTable("wallet_topups")) {
      // Express the same Pending/Processing/Unknown set by excluding the three
      // terminal values that already existed. PostgreSQL forbids using a newly
      // added enum value in the same transaction that added it.
      await knex.raw(`
        CREATE INDEX IF NOT EXISTS idx_wallet_topups_reconcile_due
        ON wallet_topups (next_reconcile_at, id)
        WHERE sale_reference_id IS NOT NULL
          AND next_reconcile_at IS NOT NULL
          AND status NOT IN ('Success', 'Failed', 'Cancelled')
      `);
    }
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    await knex.raw("DROP INDEX IF EXISTS idx_wallet_topups_reconcile_due");
    await dropColumn(knex, "wallet_topups", "last_provider_error");
    await dropColumn(knex, "wallet_topups", "last_provider_code");
    await dropColumn(knex, "wallet_topups", "reconcile_attempts");
    await dropColumn(knex, "wallet_topups", "next_reconcile_at");
    await dropColumn(knex, "orders", "manual_stock_applied_at");
    // PostgreSQL enum values are intentionally retained; removing them requires
    // rebuilding the enum type and is not safe in an additive rollback.
  },

  __private: { LOCK_KEY },
};
