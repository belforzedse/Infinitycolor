jest.mock("@strapi/utils", () => ({
  sanitize: { contentAPI: { output: jest.fn(async (rows) => rows) } },
}));

import controller from "../admin-order-list";
import routeConfig from "../../routes/admin-order-list";

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
  const count = jest.fn().mockResolvedValue(49_518);
  const info = jest.fn();
  (global as any).strapi = {
    query: jest.fn(() => ({ findMany, count })),
    contentType: jest.fn(() => ({})),
    log: { info },
  };
  return { findMany, count, info };
}

describe("bounded admin orders list", () => {
  it("uses the order-read capability policy", () => {
    expect(routeConfig.routes[0].config.policies[0]).toEqual({
      name: "global::require-capability",
      config: { capability: "order.read" },
    });
  });

  it("returns an explicit bounded projection and stable tab/sort query", async () => {
    const { findMany } = installStrapi([
      {
        id: 7,
        Description: "safe",
        Status: "Done",
        Date: "2026-08-06T00:00:00.000Z",
        user: {
          id: 2,
          phone: "synthetic",
          email: "must-not-leak@example.test",
          user_info: { id: 3, FirstName: "Test", LastName: "User", NationalCode: "secret" },
        },
        contract: { id: 4, Amount: 1000, private_note: "secret" },
      },
    ]);
    const ctx = createContext({
      page: 2,
      pageSize: 500,
      tab: "completed",
      sort: "newest",
      search: "synthetic-transaction",
      filters: [{ field: "[id]", operator: "$gte", value: "7" }],
    });

    await controller.query(ctx);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: 100,
        limit: 100,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    const query = findMany.mock.calls[0][0];
    expect(query.where.$and).toEqual(
      expect.arrayContaining([
        { id: { $gte: 7 } },
        { Status: { $eq: "Done" } },
        // A textual query fans out across the transaction id, customer name and
        // shipping barcode; numeric queries take the cheaper id-first branch.
        {
          $or: [
            { contract: { external_id: { $containsi: "synthetic-transaction" } } },
            { user: { user_info: { FirstName: { $containsi: "synthetic-transaction" } } } },
            { user: { user_info: { LastName: { $containsi: "synthetic-transaction" } } } },
            { ShippingBarcode: { $containsi: "synthetic-transaction" } },
          ],
        },
      ]),
    );
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(JSON.stringify(ctx.body)).not.toContain("must-not-leak");
    expect(JSON.stringify(ctx.body)).not.toContain("NationalCode");
    expect(ctx.body.meta.pagination).toEqual({
      page: 2,
      pageSize: 100,
      pageCount: 496,
      total: 49_518,
    });
  });

  it("resolves a numeric search against the order number without touching name columns", async () => {
    const { findMany } = installStrapi();
    const ctx = createContext({ search: "۱۲۳" });

    await controller.query(ctx);

    expect(findMany.mock.calls[0][0].where.$and).toEqual([
      {
        $or: [
          { id: { $eq: 123 } },
          { contract: { external_id: { $containsi: "123" } } },
          { ShippingBarcode: { $containsi: "123" } },
          { user: { phone: { $containsi: "123" } } },
        ],
      },
    ]);
  });

  it("rejects unknown filters before querying", async () => {
    const { findMany } = installStrapi();
    const ctx = createContext({
      filters: [{ field: "[user][password]", operator: "$containsi", value: "x" }],
    });

    await controller.query(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith("Unsupported orders-list filter field");
    expect(findMany).not.toHaveBeenCalled();
  });
});
