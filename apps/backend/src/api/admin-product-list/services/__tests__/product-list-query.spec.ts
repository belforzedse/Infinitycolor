jest.mock("../../../report/services/product-analytics", () => ({
  resolveJoins: jest.fn(async () => ({
    oiToOrder: "JOIN orders o ON o.id = oi.order_id",
    oiToVariation: { join: "JOIN product_variations pv ON pv.id = oi.product_variation_id" },
    variationToProduct: "JOIN products p ON p.id = pv.product_id",
  })),
  paidOrdersCte: jest.fn(() => "paid_orders AS (SELECT o.id AS order_id FROM orders o WHERE o.date BETWEEN ? AND ?)"),
}));

import {
  DEFAULT_SORT_BY_VIEW,
  PRODUCT_LIST_SORTS,
  VIEW_SQL,
  buildProductListBase,
  countProductListViews,
  findProductListPage,
  parseProductListCriteria,
  type ProductListCriteria,
} from "../product-list-query";

// A real pg-dialect knex that only compiles SQL; nothing connects to a database.
const knexPath = require.resolve("knex", {
  paths: [require.resolve("@strapi/database", { paths: [require.resolve("@strapi/strapi")] })],
});
const offlineKnex = require(knexPath)({ client: "pg" });

function makeCtx() {
  return { badRequest: jest.fn() };
}

function criteria(overrides: Partial<ProductListCriteria> = {}): ProductListCriteria {
  return {
    view: "all",
    page: 1,
    pageSize: 25,
    sort: "last-edited",
    search: "",
    categoryId: null,
    stock: null,
    productType: null,
    filters: [],
    ...overrides,
  };
}

function makeStrapi(capture: { sql: string[]; rows?: any[]; first?: any }) {
  const connection: any = (table: unknown) => {
    const builder = offlineKnex(table);
    // Resolve like knex would, recording the compiled statement.
    builder.then = (resolve: any, reject: any) => {
      capture.sql.push(builder.toString());
      return Promise.resolve(capture.rows || []).then(resolve, reject);
    };
    const originalFirst = builder.first.bind(builder);
    builder.first = (...args: unknown[]) => {
      const query = originalFirst(...args);
      query.then = (resolve: any, reject: any) => {
        capture.sql.push(query.toString());
        return Promise.resolve(capture.first).then(resolve, reject);
      };
      return query;
    };
    return builder;
  };
  connection.raw = offlineKnex.raw.bind(offlineKnex);
  return {
    db: {
      connection,
      metadata: { get: () => undefined },
      queryBuilder: jest.fn(() => ({
        select() {
          return this;
        },
        where() {
          return this;
        },
        getKnexQuery: () => offlineKnex("products as t0").select("t0.id").where("t0.title", "ilike", "%x%"),
      })),
    },
  } as any;
}

describe("admin product list criteria", () => {
  it("defaults the sort by view so Scheduled and Trash open in their natural order", () => {
    expect(parseProductListCriteria(makeCtx(), { view: "scheduled" })?.sort).toBe("scheduled-asc");
    expect(parseProductListCriteria(makeCtx(), { view: "trash" })?.sort).toBe("trashed-desc");
    expect(parseProductListCriteria(makeCtx(), {})).toEqual(
      expect.objectContaining({ view: "all", sort: DEFAULT_SORT_BY_VIEW.all, page: 1, pageSize: 25 }),
    );
  });

  it("maps the legacy recycle-bin flag to the Trash view", () => {
    expect(parseProductListCriteria(makeCtx(), { removed: true })?.view).toBe("trash");
  });

  it.each([
    [{ view: "archived" }, "Unsupported products-list view"],
    [{ sort: "price; DROP TABLE products" }, "Unsupported products-list sort"],
    [{ stock: "maybe" }, "Unsupported stock filter"],
    [{ productType: "Bundle" }, "Unsupported product type filter"],
    [{ categoryId: "-3" }, "categoryId must be a positive integer"],
    [{ search: "x".repeat(81) }, "search must contain at most 80 characters"],
    [{ filters: [{ field: "[Description]", operator: "$eq", value: "x" }] }, "Unsupported products-list filter field"],
  ])("rejects %j", (body, message) => {
    const ctx = makeCtx();
    expect(parseProductListCriteria(ctx, body)).toBeNull();
    expect(ctx.badRequest).toHaveBeenCalledWith(message);
  });

  it("caps page size at the admin maximum", () => {
    expect(parseProductListCriteria(makeCtx(), { pageSize: 5000 })?.pageSize).toBe(100);
  });
});

describe("admin product list SQL", () => {
  it("keeps Trash out of All and splits the lifecycle buckets on separate dimensions", () => {
    expect(VIEW_SQL.all).toBe("p.removed_at IS NULL");
    expect(VIEW_SQL.published).toContain("p.status = 'Active'");
    expect(VIEW_SQL.scheduled).toContain("p.status = 'Scheduled'");
    expect(VIEW_SQL.drafts).toContain("p.status IS NULL");
    expect(VIEW_SQL.trash).toBe("p.removed_at IS NOT NULL AND p.purged_at IS NULL");
    for (const view of ["published", "drafts", "scheduled"] as const) {
      expect(VIEW_SQL[view]).toContain("p.removed_at IS NULL");
    }
  });

  it("composes search, category, stock and type with the view, binding every value", async () => {
    const capture = { sql: [] as string[], rows: [{ id: 5 }], first: { total: "1" } };
    const strapi = makeStrapi(capture);

    await findProductListPage(
      strapi,
      criteria({
        view: "scheduled",
        sort: "scheduled-asc",
        search: "iphone",
        categoryId: 12,
        stock: "in",
        productType: "Variable",
        page: 3,
        pageSize: 10,
      }),
    );

    const [listSql, totalSql] = capture.sql;
    expect(listSql).toContain(VIEW_SQL.scheduled);
    expect(listSql).toContain("p.title ILIKE '%iphone%'");
    expect(listSql).toContain("pv.sku ILIKE '%iphone%'");
    expect(listSql).toContain("= 12)");
    expect(listSql).toContain("COALESCE(ps.count, 0) > 0");
    expect(listSql).toContain(`"p"."product_type" = 'Variable'`);
    expect(listSql).toMatch(/order by p\.scheduled_publish_at ASC NULLS LAST, p\.id ASC limit 10 offset 20$/);
    expect(totalSql).toContain("count(\"p\".\"id\")");
    expect(totalSql).toContain(VIEW_SQL.scheduled);
  });

  it("searches by product id when the term is a number", () => {
    const sql = buildProductListBase(makeStrapi({ sql: [] }), criteria({ search: "#4719" })).toString();
    expect(sql).toContain(`"p"."id" = 4719`);
  });

  it("escapes LIKE wildcards in the search term", () => {
    const sql = buildProductListBase(makeStrapi({ sql: [] }), criteria({ search: "50%_off" })).toString();
    expect(sql).toContain("50\\\\%\\\\_off");
  });

  it("narrows by advanced filters through Strapi's own compiled id subquery", () => {
    const strapi = makeStrapi({ sql: [] });
    const sql = buildProductListBase(
      strapi,
      criteria({ filters: [{ Title: { $containsi: "x" } }] }),
    ).toString();
    expect(strapi.db.queryBuilder).toHaveBeenCalledWith("api::product.product");
    expect(sql).toContain(`"p"."id" in (select "t0"."id" from "products" as "t0"`);
  });

  it("sorts by 30-day sales with a left join, so products without sales stay listed", async () => {
    const capture = { sql: [] as string[], rows: [], first: { total: "0" } };
    await findProductListPage(makeStrapi(capture), criteria({ sort: "sales-desc" }));
    expect(capture.sql[0]).toContain("left join \"product_sales\"");
    expect(capture.sql[0]).toContain("COALESCE(product_sales.quantity, 0) DESC");
  });

  it("maps every allowlisted sort to a fixed ORDER BY", async () => {
    for (const sort of PRODUCT_LIST_SORTS) {
      const capture = { sql: [] as string[], rows: [], first: { total: "0" } };
      await findProductListPage(makeStrapi(capture), criteria({ sort }));
      expect(capture.sql[0]).toMatch(/order by [\s\S]+ (ASC|DESC)/i);
    }
  });

  it("counts all five tabs in one statement with the secondary filters and without the tab", async () => {
    const capture = {
      sql: [] as string[],
      first: { all: "7", published: "4", drafts: "2", scheduled: "1", trash: "3" },
    };
    const counts = await countProductListViews(
      makeStrapi(capture),
      criteria({ view: "trash", search: "shirt" }),
    );

    expect(counts).toEqual({ all: 7, published: 4, drafts: 2, scheduled: 1, trash: 3 });
    expect(capture.sql).toHaveLength(1);
    const [sql] = capture.sql;
    expect(sql).toContain("p.title ILIKE '%shirt%'");
    for (const view of ["all", "published", "drafts", "scheduled", "trash"] as const) {
      expect(sql).toContain(`COUNT(*) FILTER (WHERE ${VIEW_SQL[view]})::bigint AS "${view}"`);
    }
  });
});
