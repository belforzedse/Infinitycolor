jest.mock("@strapi/utils", () => ({
  sanitize: {
    contentAPI: {
      output: jest.fn(async (rows) => rows),
    },
  },
}));

import controller from "../admin-user";
import routeConfig from "../../routes/admin-user";
import { MANAGEMENT_ROLES, ROLE_NAMES } from "../../../../utils/roles";

function createContext(body: Record<string, unknown> = {}) {
  return {
    request: { body },
    state: { auth: { strategy: { name: "better-auth-jwt" } }, user: { id: 1 } },
    body: null as any,
    badRequest: jest.fn(),
    set: jest.fn(),
  };
}

function installStrapi(rows: any[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const count = jest.fn().mockResolvedValueOnce(22_966).mockResolvedValueOnce(0);
  const info = jest.fn();
  (global as any).strapi = {
    query: jest.fn(() => ({ findMany, count })),
    contentType: jest.fn(() => ({ uid: "plugin::users-permissions.user" })),
    log: { info },
  };
  return { findMany, count, info };
}

describe("bounded admin users list", () => {
  it("is protected by the Superadmin policy", () => {
    const route = routeConfig.routes.find((entry) => entry.path === "/admin/users-list/query");
    expect(route).toEqual(
      expect.objectContaining({
        method: "POST",
        handler: "admin-user.query",
        config: {
          auth: { scope: [] },
          policies: [
            {
              name: "global::role-based",
              config: { roles: [ROLE_NAMES.SUPERADMIN] },
            },
          ],
        },
      }),
    );
  });

  it("returns a bounded explicit projection with exact totals and recycle metadata", async () => {
    const { findMany, count, info } = installStrapi([
      {
        id: 12,
        username: "customer-12",
        phone: "+989120000000",
        email: "must-not-leak@example.test",
        password: "must-not-leak",
        confirmed: true,
        blocked: false,
        IsActive: true,
        IsVerified: true,
        removedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        user_info: {
          id: 13,
          FirstName: "Synthetic",
          LastName: "Customer",
          NationalCode: "must-not-leak",
        },
        user_role: null,
        role: { id: 5, name: "Customer", type: "customer" },
        user_wallet: { id: 14, Balance: 500_000, description: "must-not-leak" },
      },
    ]);
    const ctx = createContext({ page: 2, pageSize: 500 });

    await controller.query(ctx);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: 100,
        limit: 100,
        orderBy: { id: "desc" },
        select: [
          "id",
          "username",
          "phone",
          "confirmed",
          "blocked",
          "IsActive",
          "IsVerified",
          "removedAt",
          "createdAt",
          "updatedAt",
        ],
        populate: {
          user_info: { select: ["id", "FirstName", "LastName"] },
          user_role: { select: ["id", "Title"] },
          role: { select: ["id", "name", "type"] },
          user_wallet: { select: ["id", "Balance"] },
        },
      }),
    );
    expect(count).toHaveBeenCalledTimes(2);
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(ctx.body.meta).toEqual({
      pagination: { page: 2, pageSize: 100, pageCount: 230, total: 22_966 },
      recycleCount: 0,
    });
    expect(ctx.body.data).toHaveLength(1);
    expect(JSON.stringify(ctx.body)).not.toContain("must-not-leak");
    expect(JSON.stringify(ctx.body)).not.toContain("email");
    expect(JSON.stringify(ctx.body)).not.toContain("password");
    expect(info).toHaveBeenCalledWith(
      "admin users list completed",
      expect.objectContaining({ page: 2, pageSize: 100, returned: 1, total: 22_966 }),
    );
  });

  it("builds allowlisted search, filters, role filtering, and stable sorting", async () => {
    const { findMany, info } = installStrapi([]);
    const ctx = createContext({
      search: "Synthetic Person",
      managerRolesOnly: true,
      filters: [
        { field: "[phone]", operator: "$startsWith", value: "+98912" },
        { field: "[confirmed]", operator: "$eq", value: true },
      ],
      sort: { field: "createdAt", direction: "asc" },
    });

    await controller.query(ctx);

    const query = findMany.mock.calls[0][0];
    expect(query.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    expect(query.where.$and).toEqual(
      expect.arrayContaining([
        { phone: { $startsWith: "+98912" } },
        { confirmed: { $eq: true } },
        { role: { name: { $in: MANAGEMENT_ROLES } } },
      ]),
    );
    expect(query.where.$and.some((entry: any) => Array.isArray(entry.$or))).toBe(true);

    const loggedMetadata = JSON.stringify(info.mock.calls[0]);
    expect(loggedMetadata).not.toContain("Synthetic Person");
    expect(loggedMetadata).not.toContain("+98912");
  });

  it("rejects unknown filters before querying the database", async () => {
    const { findMany, count } = installStrapi([]);
    const ctx = createContext({
      filters: [{ field: "[password]", operator: "$containsi", value: "secret" }],
    });

    await controller.query(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith("Unsupported users-list filter field");
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });
});
