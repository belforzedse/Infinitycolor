jest.mock("@strapi/utils", () => ({
  sanitize: { contentAPI: { output: jest.fn(async (rows) => rows) } },
}));

import controller from "../admin-order-list";
import routeConfig from "../../routes/admin-order-list";
import { STORE_MANAGER_PLUS_ROLES } from "../../../../utils/roles";

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
  it("uses the operational role policy", () => {
    expect(routeConfig.routes[0].config.policies[0]).toEqual({
      name: "global::role-based",
      config: { roles: STORE_MANAGER_PLUS_ROLES },
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
        { contract: { external_id: { $containsi: "synthetic-transaction" } } },
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
