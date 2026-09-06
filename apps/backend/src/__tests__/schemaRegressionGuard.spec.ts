import {
  collectDeclaredColumns,
  findColumnRegressions,
} from "../bootstrap/schemaRegressionGuard";

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

  it("flags a persisted column the running build no longer declares", () => {
    const persisted = {
      tables: [{ name: "orders", columns: [{ name: "id" }, { name: "analytics_correlation_id" }] }],
    };

    // The exact 2026-08-29 regression: an older image that never knew the column.
    expect(findColumnRegressions(persisted, collectDeclaredColumns(metadataOf({ orders: ["id"] }))))
      .toEqual(["orders.analytics_correlation_id"]);
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
