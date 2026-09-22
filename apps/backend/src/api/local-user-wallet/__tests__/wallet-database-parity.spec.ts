import { __private as bootstrapDatabase } from "../services/wallet-database";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const migration = require("../../../../database/migrations/2026.09.19T12.00.00.repair-wallet-holds-and-topups.js");

const TOPUP_COLUMNS = [
  "amount",
  "gateway",
  "status",
  "sale_order_id",
  "ref_id",
  "sale_reference_id",
  "provider_reference",
  "verification_reference",
  "expires_at",
  "ledger_reference_id",
  "idempotency_key",
  "redirect_url",
  "redirect_method",
  "next_reconcile_at",
  "reconcile_attempts",
  "last_provider_code",
  "last_provider_error",
];

const normalizeSql = (statement: string) => statement.replace(/\s+/g, " ").trim();

function makeLegacyKnex(options: { topupTableExists: boolean }) {
  const sql: string[] = [];
  const tables = new Set([
    "admin_users",
    "users",
    "local_user_wallets",
    "local_user_wallets_user_links",
    "local_user_wallet_transactions",
    "payment_attempts",
    ...(options.topupTableExists ? ["wallet_topups", "wallet_topups_user_links"] : []),
  ]);

  const raw = jest.fn(async (statement: string) => {
    sql.push(statement);
    if (statement.includes("SELECT convalidated FROM pg_constraint")) {
      return { rows: [{ convalidated: true }] };
    }
    if (statement.includes("wallet_topups_user_links_unique")) {
      return { rows: [{ exists: 1 }] };
    }
    return { rows: [] };
  });
  const knex = {
    client: { config: { client: "pg" } },
    schema: {
      hasTable: jest.fn(async (table: string) => tables.has(table)),
      hasColumn: jest.fn(async () => false),
    },
    raw,
  };

  return { knex, sql };
}

describe("wallet repair migration parity", () => {
  it("keeps migration and post-schema-sync uniqueness identical", () => {
    expect(migration.__private.WALLET_UNIQUE_INDEXES.map(normalizeSql)).toEqual(
      bootstrapDatabase.WALLET_UNIQUE_INDEXES.map((entry) => normalizeSql(entry.statement)),
    );
  });

  it("keeps every durable top-up replay column in the repair list", () => {
    expect(migration.__private.WALLET_TOPUP_COLUMNS.map(([name]: [string]) => name)).toEqual(
      TOPUP_COLUMNS,
    );
  });

  it("repairs all top-up columns on the legacy production-shaped table", async () => {
    const { knex, sql } = makeLegacyKnex({ topupTableExists: true });

    await migration.up(knex);

    for (const column of TOPUP_COLUMNS) {
      expect(sql.some((statement) => statement.includes(`ALTER TABLE wallet_topups ADD COLUMN ${column} `))).toBe(
        true,
      );
    }
    expect(sql.some((statement) => statement.includes("idx_wallet_topups_sale_order_id"))).toBe(true);
    expect(sql.some((statement) => statement.includes("idx_wallet_topups_idempotency_key"))).toBe(true);
    expect(sql.some((statement) => statement.includes("idx_wallet_topups_one_owner"))).toBe(true);
  });

  it("creates the complete top-up table when legacy production has none", async () => {
    const { knex, sql } = makeLegacyKnex({ topupTableExists: false });

    await migration.up(knex);

    const createTable = sql.find((statement) => statement.includes("CREATE TABLE wallet_topups ("));
    expect(createTable).toBeDefined();
    for (const column of TOPUP_COLUMNS) {
      expect(createTable).toContain(column);
    }
  });
});
