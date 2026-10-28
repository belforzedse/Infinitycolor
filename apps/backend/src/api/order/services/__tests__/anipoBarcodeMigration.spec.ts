const migration = require("../../../../../database/migrations/2026.09.01T15.30.00.repair-anipo-order-schema-drift.js");
const barcodeDataMigration = require("../../../../../database/migrations/2026.09.26T12.00.00.add-anipo-barcode-data.js");

function createFakeKnex(tableExists = true) {
  const columns = new Set<string>();
  const addedColumns: string[] = [];
  const chain = {
    nullable: jest.fn(() => chain),
    notNullable: jest.fn(() => chain),
    defaultTo: jest.fn(() => chain),
  };
  const table = {
    string: jest.fn((name: string) => {
      columns.add(name);
      addedColumns.push(name);
      return chain;
    }),
    datetime: jest.fn((name: string) => {
      columns.add(name);
      addedColumns.push(name);
      return chain;
    }),
    integer: jest.fn((name: string) => {
      columns.add(name);
      addedColumns.push(name);
      return chain;
    }),
    boolean: jest.fn((name: string) => {
      columns.add(name);
      addedColumns.push(name);
      return chain;
    }),
    text: jest.fn((name: string) => {
      columns.add(name);
      addedColumns.push(name);
      return chain;
    }),
    jsonb: jest.fn((name: string) => {
      columns.add(name);
      addedColumns.push(name);
      return chain;
    }),
  };
  const raw = jest.fn().mockResolvedValue({ rows: [] });
  const knex = {
    raw,
    schema: {
      hasTable: jest.fn().mockResolvedValue(tableExists),
      hasColumn: jest.fn(async (_table: string, name: string) => columns.has(name)),
      alterTable: jest.fn(async (_table: string, add: (builder: typeof table) => void) => {
        add(table);
      }),
    },
  };

  return { knex, columns, addedColumns, raw };
}

describe("Anipo order schema drift repair migration", () => {
  it("restores every workflow column and is safe to rerun", async () => {
    const { knex, columns, addedColumns, raw } = createFakeKnex();

    await migration.up(knex);
    await migration.up(knex);

    expect([...columns]).toEqual([
      "anipo_barcode_state",
      "anipo_submitted_at",
      "anipo_last_checked_at",
      "anipo_polling_deadline_at",
      "anipo_issued_at",
      "anipo_check_count",
      "anipo_ready_to_issue",
      "anipo_provider_status",
      "anipo_last_message",
      "anipo_last_error",
    ]);
    expect(addedColumns).toHaveLength(10);
    expect(raw).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock(?)", [827453110]);
    expect(raw.mock.calls.filter(([sql]) => String(sql).includes("idx_orders_anipo_barcode_pending")))
      .toHaveLength(2);
  });

  it("does not attempt to alter an order table that has not been created yet", async () => {
    const { knex } = createFakeKnex(false);

    await migration.up(knex);

    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  it("adds barcode data once without removing historical tracking columns", async () => {
    const { knex, addedColumns } = createFakeKnex();
    await barcodeDataMigration.up(knex);
    await barcodeDataMigration.up(knex);
    expect(addedColumns).toEqual(["anipo_barcode_data"]);
    expect(knex.schema.alterTable).toHaveBeenCalledTimes(1);
  });
});
