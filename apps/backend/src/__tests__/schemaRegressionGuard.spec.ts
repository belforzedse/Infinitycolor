import { collectDeclaredColumns, findColumnRegressions } from "../bootstrap/schemaRegressionGuard";

const metadataOf = (entries: Record<string, string[]>) =>
  new Map(
    Object.entries(entries).map(([tableName, columns]) => [
      tableName,
      {
        tableName,
        attributes: Object.fromEntries(columns.map((c) => [c, { type: "string", columnName: c }])),
      },
    ]),
  );

describe("schema regression guard", () => {
  it("collects the column names a build declares, keyed by table", () => {
    const declared = collectDeclaredColumns(
      metadataOf({ orders: ["id", "analytics_correlation_id"] }),
    );

    expect([...(declared.get("orders") ?? [])].sort()).toEqual(["analytics_correlation_id", "id"]);
  });

  it("ignores attributes with no column of their own, such as join-table relations", () => {
    const metadata = new Map([
      [
        "orders",
        {
          tableName: "orders",
          attributes: {
            id: { type: "integer", columnName: "id" },
            order_items: { type: "relation", joinTable: { name: "order_items_order_links" } },
          },
        },
      ],
    ]);

    expect([...(collectDeclaredColumns(metadata).get("orders") ?? [])]).toEqual(["id"]);
  });

  it("treats same-table relation join columns as declared, including createdBy", () => {
    const metadata = new Map([
      [
        "admin_activities",
        {
          tableName: "admin_activities",
          attributes: {
            id: { type: "increments", columnName: "id" },
            createdBy: {
              type: "relation",
              joinColumn: { name: "created_by_id" },
            },
            updatedBy: {
              type: "relation",
              joinColumn: { name: "updated_by_id" },
            },
          },
        },
      ],
    ]);

    expect([...(collectDeclaredColumns(metadata).get("admin_activities") ?? [])].sort()).toEqual([
      "created_by_id",
      "id",
      "updated_by_id",
    ]);
  });

  it("does not flag created_by_id when this build declares it via joinColumn", () => {
    const persisted = {
      tables: [
        {
          name: "admin_activities",
          columns: [{ name: "id" }, { name: "created_by_id" }, { name: "updated_by_id" }],
        },
      ],
    };
    const declared = collectDeclaredColumns(
      new Map([
        [
          "admin_activities",
          {
            tableName: "admin_activities",
            attributes: {
              id: { type: "increments", columnName: "id" },
              createdBy: { type: "relation", joinColumn: { name: "created_by_id" } },
              updatedBy: { type: "relation", joinColumn: { name: "updated_by_id" } },
            },
          },
        ],
      ]),
    );

    expect(findColumnRegressions(persisted, declared)).toEqual([]);
  });

  it("treats join-table model attributes without columnName as columns named by their key", () => {
    const metadata = new Map([
      [
        "orders_local_user_links",
        {
          tableName: "orders_local_user_links",
          attributes: {
            id: { type: "increments" },
            order_id: { type: "integer" },
            local_user_id: { type: "integer" },
          },
        },
      ],
    ]);

    expect(
      [...(collectDeclaredColumns(metadata).get("orders_local_user_links") ?? [])].sort(),
    ).toEqual(["id", "local_user_id", "order_id"]);
  });

  it("treats morphToOne id and type columns as declared", () => {
    const metadata = new Map([
      [
        "up_users",
        {
          tableName: "up_users",
          attributes: {
            id: { type: "increments", columnName: "id" },
            related: {
              type: "relation",
              morphColumn: {
                idColumn: { name: "target_id" },
                typeColumn: { name: "target_type" },
              },
            },
          },
        },
      ],
    ]);

    expect([...(collectDeclaredColumns(metadata).get("up_users") ?? [])].sort()).toEqual([
      "id",
      "target_id",
      "target_type",
    ]);
  });

  it("flags a persisted column the running build no longer declares", () => {
    const persisted = {
      tables: [{ name: "orders", columns: [{ name: "id" }, { name: "analytics_correlation_id" }] }],
    };

    // The exact 2026-08-29 regression: an older image that never knew the column.
    expect(
      findColumnRegressions(persisted, collectDeclaredColumns(metadataOf({ orders: ["id"] }))),
    ).toEqual(["orders.analytics_correlation_id"]);
  });

  it("allows only the retired category-editorial ordering column", () => {
    const table = "product_category_contents_product_category_links";
    const persisted = {
      tables: [
        {
          name: table,
          columns: [
            { name: "product_category_content_id" },
            { name: "product_category_id" },
            { name: "product_category_content_order" },
          ],
        },
      ],
    };
    expect(
      findColumnRegressions(
        persisted,
        collectDeclaredColumns(
          metadataOf({ table: [] }).set(table, {
            tableName: table,
            attributes: {
              product_category_content_id: { type: "integer" },
              product_category_id: { type: "integer" },
            },
          }),
        ),
      ),
    ).toEqual([]);
  });

  it("passes when the build declares everything persisted, plus new columns", () => {
    const persisted = { tables: [{ name: "orders", columns: [{ name: "id" }] }] };

    expect(
      findColumnRegressions(
        persisted,
        collectDeclaredColumns(metadataOf({ orders: ["id", "brand_new_column"] })),
      ),
    ).toEqual([]);
  });

  // The persisted schema only ever holds content-type tables, so one the build
  // does not declare means a content type it predates — forceMigration drops
  // the whole table, which is worse than losing a single column.
  it("flags a persisted table the running build does not declare at all", () => {
    const persisted = {
      tables: [{ name: "product_slug_aliases", columns: [{ name: "slug" }] }],
    };

    expect(
      findColumnRegressions(persisted, collectDeclaredColumns(metadataOf({ orders: ["id"] }))),
    ).toEqual(["product_slug_aliases (whole table)"]);
  });

  it("reports every regression across tables, sorted", () => {
    const persisted = {
      tables: [
        { name: "products", columns: [{ name: "scheduled_publish_at" }] },
        { name: "orders", columns: [{ name: "analytics_correlation_id" }] },
      ],
    };

    expect(
      findColumnRegressions(
        persisted,
        collectDeclaredColumns(metadataOf({ orders: ["id"], products: ["id"] })),
      ),
    ).toEqual(["orders.analytics_correlation_id", "products.scheduled_publish_at"]);
  });
});
