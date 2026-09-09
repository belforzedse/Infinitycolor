const migration = require("../../database/migrations/2026.09.08T10.00.00.add-category-editorial-content.js");
const provenanceMigration = require("../../database/migrations/2026.09.09T12.00.00.add-category-editorial-import-provenance.js");

function knexDouble(options: { hasContent?: boolean; duplicates?: any[] } = {}) {
  const query: any = {};
  for (const method of ["select", "count", "whereNotNull", "groupBy", "havingRaw"]) {
    query[method] = jest.fn(() => query);
  }
  query.limit = jest.fn().mockResolvedValue(options.duplicates ?? []);
  const knex: any = jest.fn(() => query);
  knex.schema = {
    hasTable: jest.fn().mockResolvedValue(true),
    hasColumn: jest.fn().mockResolvedValue(options.hasContent ?? false),
    alterTable: jest.fn(async (_name: string, callback: any) => {
      callback({ text: jest.fn(() => ({ nullable: jest.fn() })) });
    }),
  };
  knex.raw = jest.fn().mockResolvedValue(undefined);
  return knex;
}

describe("category editorial migration", () => {
  it("adds the compatible body column and category uniqueness idempotently", async () => {
    const first = knexDouble();
    await migration.up(first);
    expect(first.schema.alterTable).toHaveBeenCalledTimes(1);
    expect(first.raw).toHaveBeenCalledWith(expect.stringContaining("ADD CONSTRAINT"));

    const rerun = knexDouble({ hasContent: true });
    await migration.up(rerun);
    expect(rerun.schema.alterTable).not.toHaveBeenCalled();
    expect(rerun.raw).toHaveBeenCalledWith(expect.stringContaining("ADD CONSTRAINT"));
  });

  it("refuses duplicate category associations without deleting data", async () => {
    const knex = knexDouble({ duplicates: [{ product_category_id: 17, count: "2" }] });
    await expect(migration.up(knex)).rejects.toThrow("refused duplicate category links (17)");
    expect(knex.raw).not.toHaveBeenCalledWith(expect.stringContaining("ADD CONSTRAINT"));
    expect(
      require("fs").readFileSync(
        require.resolve(
          "../../database/migrations/2026.09.08T10.00.00.add-category-editorial-content.js",
        ),
        "utf8",
      ),
    ).not.toMatch(/\bdelete\b|\btruncate\b/i);
  });

  it("rolls back only the uniqueness guard", async () => {
    const knex = knexDouble();
    await migration.down(knex);
    expect(knex.raw).toHaveBeenCalledWith(expect.stringContaining("DROP CONSTRAINT IF EXISTS"));
  });
});

describe("category editorial provenance migration", () => {
  it("adds every missing additive provenance column and is idempotent", async () => {
    const definitions: string[] = [];
    const table = {
      string: jest.fn((name: string) => {
        definitions.push(name);
        return { nullable: jest.fn() };
      }),
      timestamp: jest.fn((name: string) => {
        definitions.push(name);
        return { nullable: jest.fn() };
      }),
    };
    const knex: any = {
      schema: {
        hasTable: jest.fn().mockResolvedValue(true),
        hasColumn: jest.fn().mockResolvedValue(false),
        alterTable: jest.fn(async (_name: string, callback: any) => callback(table)),
      },
    };

    await provenanceMigration.up(knex);

    expect(definitions).toEqual([
      "import_source",
      "import_batch_id",
      "imported_source_hash",
      "imported_at",
    ]);
    expect(knex.schema.alterTable).toHaveBeenCalledTimes(4);

    knex.schema.hasColumn.mockResolvedValue(true);
    knex.schema.alterTable.mockClear();
    await provenanceMigration.up(knex);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  it("retains provenance on rollback", async () => {
    await expect(provenanceMigration.down()).resolves.toBeUndefined();
    expect(
      require("fs").readFileSync(
        require.resolve(
          "../../database/migrations/2026.09.09T12.00.00.add-category-editorial-import-provenance.js",
        ),
        "utf8",
      ),
    ).not.toMatch(/dropColumn|DROP\s+COLUMN/i);
  });
});
