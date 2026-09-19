"use strict";

/**
 * Wallet holds + top-up repair.
 *
 * Three separate problems are fixed here, all additive:
 *
 * 1. `wallet_topups` (and its link table) is absent in production. The table was
 *    only ever created by schema sync, and the earlier `hasTable`-guarded
 *    migration therefore skipped it and was recorded as applied — a recorded
 *    migration never reruns because the table later appears. This migration
 *    creates the Strapi-compatible shape itself so a deployment that runs with
 *    `DATABASE_FORCE_MIGRATION=false`, or with schema sync otherwise inert, still
 *    gets a working table instead of a 500 on every top-up.
 * 2. The wallet hold columns (`local_user_wallets.held_balance` and the
 *    `payment_attempts.wallet_*` family) must exist before any code that reads
 *    them boots.
 * 3. Uniqueness and CHECK constraints the ledger depends on. Strapi's
 *    `unique: true` never became an index (see wallet-database.ts), so these are
 *    installed explicitly. They are asserted here *and* in `bootstrap`
 *    (`ensureWalletDatabaseInvariants`): migrations run before schema sync, so on
 *    a fresh database the tables do not exist yet and only the bootstrap pass can
 *    do it; on an existing database this pass installs them immediately.
 *    `src/api/local-user-wallet/__tests__/wallet-database-parity.spec.ts` asserts
 *    the two copies stay identical.
 *
 * Nothing is rewritten: balances are never rebuilt from the ledger, no legacy row
 * is deleted or merged, and `payment_attempts.wallet_hold_status` is deliberately
 * left NULL on existing rows — NULL is the durable discriminator that routes a
 * pre-deploy wallet order down the legacy direct-debit settlement path.
 */
const LOCK_KEY = 827453115;

const WALLET_UNIQUE_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_local_user_wallets_one_per_user
     ON local_user_wallets_user_links ((
       CASE WHEN user_id IS NOT NULL THEN user_id ELSE NULL END
     ))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_reference_id
     ON local_user_wallet_transactions ((
       CASE WHEN reference_id IS NOT NULL THEN reference_id ELSE NULL END
     ))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_topups_sale_order_id
     ON wallet_topups ((
       CASE WHEN sale_order_id IS NOT NULL THEN sale_order_id ELSE NULL END
     ))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_topups_idempotency_key
     ON wallet_topups ((
       CASE WHEN idempotency_key IS NOT NULL THEN idempotency_key ELSE NULL END
     ))`,
];

const WALLET_CHECK_CONSTRAINTS = [
  {
    name: "chk_local_user_wallets_balance_nonneg",
    table: "local_user_wallets",
    expression: "COALESCE(balance, 0) >= 0",
  },
  {
    name: "chk_local_user_wallets_held_within_balance",
    table: "local_user_wallets",
    expression:
      "COALESCE(held_balance, 0) >= 0 AND COALESCE(held_balance, 0) <= COALESCE(balance, 0)",
  },
];

/** Columns added to an existing table. `[name, ddl type]`. */
const PAYMENT_ATTEMPT_COLUMNS = [
  ["wallet_amount", "bigint"],
  ["gateway_amount", "bigint"],
  ["wallet_hold_status", "character varying(255)"],
  ["wallet_held_at", "timestamp(6) without time zone"],
  ["wallet_captured_at", "timestamp(6) without time zone"],
  ["wallet_released_at", "timestamp(6) without time zone"],
  ["wallet_release_reason", "character varying(255)"],
  ["wallet_ledger_reference_id", "character varying(255)"],
  ["supersedes_attempt_id", "character varying(255)"],
];

const WALLET_TOPUP_COLUMNS = [
  ["gateway", "character varying(255)"],
  ["provider_reference", "character varying(255)"],
  ["expires_at", "timestamp(6) without time zone"],
  ["ledger_reference_id", "character varying(255)"],
  ["idempotency_key", "character varying(255)"],
];

async function addColumns(knex, table, columns) {
  if (!(await knex.schema.hasTable(table))) return;
  for (const [name, type] of columns) {
    if (await knex.schema.hasColumn(table, name)) continue;
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

async function createWalletTopupTables(knex) {
  // Migrations run before schema sync, so on a first boot `admin_users`/`users`
  // do not exist yet and there is nothing to repair: sync creates the whole
  // schema a moment later. Only an existing database can be missing this table.
  if (!(await knex.schema.hasTable("admin_users")) || !(await knex.schema.hasTable("users"))) {
    return;
  }

  if (!(await knex.schema.hasTable("wallet_topups"))) {
    await knex.raw(`
      CREATE TABLE wallet_topups (
        id serial PRIMARY KEY,
        amount bigint,
        gateway character varying(255),
        status character varying(255),
        sale_order_id character varying(255),
        ref_id character varying(255),
        sale_reference_id character varying(255),
        provider_reference character varying(255),
        expires_at timestamp(6) without time zone,
        ledger_reference_id character varying(255),
        idempotency_key character varying(255),
        next_reconcile_at timestamp(6) without time zone,
        reconcile_attempts integer,
        last_provider_code integer,
        last_provider_error text,
        note text,
        date timestamp(6) without time zone,
        created_at timestamp(6) without time zone,
        updated_at timestamp(6) without time zone,
        created_by_id integer,
        updated_by_id integer
      )`);
    await knex.raw(
      `ALTER TABLE wallet_topups
         ADD CONSTRAINT wallet_topups_created_by_id_fk
         FOREIGN KEY (created_by_id) REFERENCES admin_users(id) ON DELETE SET NULL`,
    );
    await knex.raw(
      `ALTER TABLE wallet_topups
         ADD CONSTRAINT wallet_topups_updated_by_id_fk
         FOREIGN KEY (updated_by_id) REFERENCES admin_users(id) ON DELETE SET NULL`,
    );
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS wallet_topups_created_by_id_fk ON wallet_topups (created_by_id)`,
    );
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS wallet_topups_updated_by_id_fk ON wallet_topups (updated_by_id)`,
    );
  }

  if (!(await knex.schema.hasTable("wallet_topups_user_links"))) {
    await knex.raw(`
      CREATE TABLE wallet_topups_user_links (
        id serial PRIMARY KEY,
        wallet_topup_id integer,
        user_id integer
      )`);
    await knex.raw(
      `ALTER TABLE wallet_topups_user_links
         ADD CONSTRAINT wallet_topups_user_links_fk
         FOREIGN KEY (wallet_topup_id) REFERENCES wallet_topups(id) ON DELETE CASCADE`,
    );
    await knex.raw(
      `ALTER TABLE wallet_topups_user_links
         ADD CONSTRAINT wallet_topups_user_links_inv_fk
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`,
    );
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS wallet_topups_user_links_fk
         ON wallet_topups_user_links (wallet_topup_id)`,
    );
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS wallet_topups_user_links_inv_fk
         ON wallet_topups_user_links (user_id)`,
    );
    await knex.raw(
      `ALTER TABLE wallet_topups_user_links
         ADD CONSTRAINT wallet_topups_user_links_unique UNIQUE (wallet_topup_id, user_id)`,
    );
  }
}

async function ensureCheckConstraint(knex, constraint) {
  const existing = await knex.raw(
    `SELECT convalidated FROM pg_constraint WHERE conname = ? LIMIT 1`,
    [constraint.name],
  );
  if (!existing.rows.length) {
    await knex.raw(
      `ALTER TABLE ${constraint.table}
         ADD CONSTRAINT ${constraint.name} CHECK (${constraint.expression}) NOT VALID`,
    );
  } else if (existing.rows[0].convalidated === true) {
    return;
  }
  const violations = await knex.raw(
    `SELECT COUNT(*)::int AS count FROM ${constraint.table} WHERE NOT (${constraint.expression})`,
  );
  if (Number(violations.rows[0].count) > 0) return;
  await knex.raw(`ALTER TABLE ${constraint.table} VALIDATE CONSTRAINT ${constraint.name}`);
}

module.exports = {
  async up(knex) {
    const client = String(knex.client?.config?.client || "").toLowerCase();
    if (!client.includes("pg") && !client.includes("postgres")) return;

    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);

    // `local_user_wallets` is created by schema sync, so on a first boot this is
    // a no-op and `ensureWalletDatabaseInvariants` does the work instead.
    if (await knex.schema.hasTable("local_user_wallets")) {
      if (!(await knex.schema.hasColumn("local_user_wallets", "held_balance"))) {
        // Nullable and without a DDL default on purpose: Strapi applies
        // `required`/`default` in the entity layer, and a DDL default or NOT NULL
        // here would be diffed as a column change and rewritten on the next sync.
        await knex.raw("ALTER TABLE local_user_wallets ADD COLUMN held_balance bigint");
      }
      await knex.raw(
        "UPDATE local_user_wallets SET held_balance = 0 WHERE held_balance IS NULL",
      );
    }

    await addColumns(knex, "payment_attempts", PAYMENT_ATTEMPT_COLUMNS);
    await createWalletTopupTables(knex);
    await addColumns(knex, "wallet_topups", WALLET_TOPUP_COLUMNS);
    if (await knex.schema.hasTable("wallet_topups")) {
      await knex.raw("UPDATE wallet_topups SET gateway = 'Mellat' WHERE gateway IS NULL");
    }

    for (const statement of WALLET_UNIQUE_INDEXES) {
      const table = statement.match(/ON\s+([a-z_]+)/i)?.[1];
      if (table && !(await knex.schema.hasTable(table))) continue;
      try {
        await knex.raw(statement);
      } catch (error) {
        // Legacy duplicates must not stop a deployment. The capability stays off:
        // wallet-readiness.ts verifies the index and keeps holds/top-ups disabled.
        // eslint-disable-next-line no-console
        console.error(
          `[wallet-repair] could not create uniqueness: ${String(error.message).slice(0, 300)}`,
        );
      }
    }

    for (const constraint of WALLET_CHECK_CONSTRAINTS) {
      if (!(await knex.schema.hasTable(constraint.table))) continue;
      try {
        await ensureCheckConstraint(knex, constraint);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          `[wallet-repair] could not assert ${constraint.name}: ${String(error.message).slice(0, 300)}`,
        );
      }
    }
  },

  async down() {
    // Intentionally irreversible. Dropping the hold columns while any attempt is
    // still `Active` would strand held customer money with no record of the hold.
  },

  __private: {
    LOCK_KEY,
    WALLET_UNIQUE_INDEXES,
    WALLET_CHECK_CONSTRAINTS,
    PAYMENT_ATTEMPT_COLUMNS,
    WALLET_TOPUP_COLUMNS,
  },
};
