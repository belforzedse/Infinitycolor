const hardeningMigration = require(
  "../../../../../database/migrations/2026.07.27T12.00.00.harden-snappay-payments.js",
);
const conflictingIndexRepair = require(
  "../../../../../database/migrations/2026.07.28T12.00.00.drop-strapi-conflicting-snappay-indexes.js",
);

function createMockKnex() {
  const raw = jest.fn(async () => ({ rows: [] }));
  const hasTable = jest.fn(async (tableName: string) =>
    ["payment_attempts", "contract_transactions", "payment_operations"].includes(tableName),
  );
  const hasColumn = jest.fn(async (_tableName: string, columnName: string) =>
    columnName !== "gateway_response",
  );

  return {
    raw,
    schema: {
      hasTable,
      hasColumn,
      alterTable: jest.fn(),
      createTable: jest.fn(),
    },
    fn: {
      now: jest.fn(),
    },
  };
}

function rawStatements(knex: ReturnType<typeof createMockKnex>): string[] {
  return knex.raw.mock.calls.map(([statement]) => String(statement));
}

describe("SnappPay database migrations", () => {
  it("never creates unique indexes that conflict with Strapi schema synchronization", async () => {
    const knex = createMockKnex();

    await expect(hardeningMigration.up(knex)).resolves.toBeUndefined();

    const statements = rawStatements(knex);
    expect(statements.some((statement) => statement.includes("CREATE UNIQUE INDEX"))).toBe(false);
    expect(
      statements.some((statement) => statement.includes("idx_payment_attempts_snappay_due")),
    ).toBe(true);
    expect(
      statements.some((statement) => statement.includes("idx_payment_operations_due")),
    ).toBe(true);
  });

  it("drops every persisted unique index that can crash Strapi startup", async () => {
    const knex = createMockKnex();

    await expect(conflictingIndexRepair.up(knex)).resolves.toBeUndefined();

    const dropStatements = rawStatements(knex).filter((statement) =>
      statement.includes("DROP INDEX IF EXISTS"),
    );
    expect(dropStatements).toEqual([
      'DROP INDEX IF EXISTS "idx_payment_attempts_attempt_id"',
      'DROP INDEX IF EXISTS "idx_payment_attempts_snappay_transaction"',
      'DROP INDEX IF EXISTS "idx_contract_transactions_snappay_transaction"',
      'DROP INDEX IF EXISTS "idx_payment_operations_idempotency_key"',
    ]);
  });
});
