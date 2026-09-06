import databaseConfig from "../../../config/database";

const persistedTablesMigration = require(
  "../../../database/migrations/2026.08.06T09.00.00.persist-custom-database-tables.js",
);
const externalIdentityMigration = require(
  "../../../database/migrations/2026.08.06T09.10.00.convert-external-identity-indexes-to-constraints.js",
);

const externalIdentitySchemas = [
  {
    indexName: "uq_products_external_source_id",
    schema: require("../../api/product/content-types/product/schema.json"),
  },
  {
    indexName: "uq_product_variations_external_source_id",
    schema: require("../../api/product-variation/content-types/product-variation/schema.json"),
  },
  {
    indexName: "uq_product_stocks_external_source_id",
    schema: require("../../api/product-stock/content-types/product-stock/schema.json"),
  },
  {
    indexName: "uq_orders_external_source_id",
    schema: require("../../api/order/content-types/order/schema.json"),
  },
  {
    indexName: "uq_contracts_external_source_id",
    schema: require("../../api/contract/content-types/contract/schema.json"),
  },
  {
    indexName: "uq_order_items_external_source_id",
    schema: require("../../api/order-item/content-types/order-item/schema.json"),
  },
  {
    indexName: "uq_users_external_source_id",
    schema: require("../../extensions/users-permissions/content-types/user/schema.json"),
  },
];

describe("Strapi database schema safety", () => {
  it("uses Strapi's default destructive migration mode with persisted custom tables", () => {
    const env: any = (_key: string, defaultValue: unknown) => defaultValue;
    env.bool = (_key: string, defaultValue: boolean) => defaultValue;
    env.int = (_key: string, defaultValue: number) => defaultValue;

    const config = databaseConfig({ env }) as any;
    expect(config.settings.forceMigration).toBe(true);
  });

  // Switchable only so a one-shot repair boot can sync additively. Leaving it
  // false permanently makes sync skip dropping a changed index but still try to
  // recreate it, which aborts startup.
  it("lets DATABASE_FORCE_MIGRATION turn off destructive schema sync", () => {
    const env: any = (_key: string, defaultValue: unknown) => defaultValue;
    env.bool = (key: string, defaultValue: boolean) =>
      key === "DATABASE_FORCE_MIGRATION" ? false : defaultValue;
    env.int = (_key: string, defaultValue: number) => defaultValue;

    const config = databaseConfig({ env }) as any;
    expect(config.settings.forceMigration).toBe(false);
  });

  it("preserves existing core-store entries while registering every custom table", () => {
    const existing = [
      "existing_table",
      { name: "dependent_table", dependsOn: [{ name: "existing_table" }] },
      "analytics_daily_sales",
    ];

    const merged = persistedTablesMigration.__private.addCustomTables(existing);

    expect(merged.slice(0, existing.length)).toEqual(existing);
    expect(new Set(merged.map((entry: string | { name: string }) =>
      typeof entry === "string" ? entry : entry.name,
    ))).toEqual(
      new Set([
        "existing_table",
        "dependent_table",
        ...persistedTablesMigration.__private.CUSTOM_TABLE_NAMES,
      ]),
    );
  });

  it("removes only this migration's entries on rollback", () => {
    const existing = [
      "existing_table",
      { name: "dependent_table", dependsOn: [{ name: "existing_table" }] },
      ...persistedTablesMigration.__private.CUSTOM_TABLE_NAMES,
    ];

    expect(persistedTablesMigration.__private.removeCustomTables(existing)).toEqual(
      existing.slice(0, 2),
    );
  });

  it("fails closed for malformed persisted-table state", () => {
    expect(() => persistedTablesMigration.__private.parsePersistedTables("{}"))
      .toThrow("must contain a JSON array");
    expect(() => persistedTablesMigration.__private.parsePersistedTables('[{"dependsOn":[]} ]'))
      .toThrow("contains an invalid table entry");
  });

  it.each(externalIdentitySchemas)(
    "declares $indexName so Strapi retains the migration-owned unique index",
    ({ indexName, schema }) => {
      expect(schema.indexes).toContainEqual({
        name: indexName,
        columns: ["external_source", "external_id"],
        type: "unique",
      });
      expect(schema.attributes.external_id.unique).not.toBe(true);
    },
  );

  it("converts every declared external identity index to a Strapi-manageable constraint", () => {
    expect(
      externalIdentityMigration.__private.EXTERNAL_IDENTITY_CONSTRAINTS.map(
        ([, constraintName]: [string, string]) => constraintName,
      ),
    ).toEqual(externalIdentitySchemas.map(({ indexName }) => indexName));
  });
});
