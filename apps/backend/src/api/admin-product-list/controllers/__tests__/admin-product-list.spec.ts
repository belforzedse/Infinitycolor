jest.mock("@strapi/utils", () => ({
  sanitize: { contentAPI: { output: jest.fn(async (rows) => rows) } },
}));

import controller from "../admin-product-list";
import routeConfig from "../../routes/admin-product-list";

function createContext(body: Record<string, unknown> = {}) {
  return {
    request: { body },
    state: { auth: {}, user: { id: 1 } },
    body: null as any,
    badRequest: jest.fn(),
    set: jest.fn(),
  };
}

function installStrapi(rows: any[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const count = jest.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(3_004);
  (global as any).strapi = {
    query: jest.fn(() => ({ findMany, count })),
    contentType: jest.fn(() => ({})),
    log: { info: jest.fn() },
    db: { connection: { raw: jest.fn() } },
  };
  return { findMany, count };
}

describe("bounded admin products list", () => {
  it("uses the product-read capability policy", () => {
    expect(routeConfig.routes[0].config.policies[0]).toEqual({
      name: "global::require-capability",
      config: { capability: "product.read" },
    });
  });

  it("returns only list fields and relation projections", async () => {
    const { findMany } = installStrapi([
      {
        id: 8,
        Title: "Synthetic Product",
        Description: "must-not-leak-richtext",
        CleaningTips: "must-not-leak",
        product_variations: [
          {
            id: 9,
            SKU: "SKU-9",
            Price: "100",
            product_stock: { id: 10, Count: 4, private: "must-not-leak" },
          },
        ],
        CoverImage: { id: 11, name: "image", url: "/safe.jpg", hash: "must-not-leak" },
      },
    ]);
    const ctx = createContext({
      page: 1,
      pageSize: 25,
      sort: "last-edited",
      search: "Synthetic",
    });

    await controller.query(ctx);

    const query = findMany.mock.calls[0][0];
    expect(query.limit).toBe(25);
    expect(query.select).not.toContain("Description");
    expect(query.select).not.toContain("CleaningTips");
    expect(query.where.$and).toContainEqual({ $or: [{ Title: { $containsi: "Synthetic" } }] });
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(ctx.body.meta.recycleCount).toBe(4);
    expect(ctx.body.meta.pagination.total).toBe(3_004);
    expect(JSON.stringify(ctx.body)).not.toContain("must-not-leak");
  });

  it("finds a product code typed without the space the title stores", async () => {
    const { findMany } = installStrapi();
    const ctx = createContext({
      page: 1,
      pageSize: 25,
      sort: "last-edited",
      search: "W00288",
    });

    await controller.query(ctx);

    expect(findMany.mock.calls[0][0].where.$and).toContainEqual({
      $or: [{ Title: { $containsi: "W00288" } }, { Title: { $containsi: "W 00288" } }],
    });
  });

  it("rejects unknown filters before fetching products", async () => {
    const { findMany } = installStrapi();
    const ctx = createContext({
      filters: [{ field: "[Description]", operator: "$containsi", value: "x" }],
    });

    await controller.query(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith("Unsupported products-list filter field");
    expect(findMany).not.toHaveBeenCalled();
  });
});
