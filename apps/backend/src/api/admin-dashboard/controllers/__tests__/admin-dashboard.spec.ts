jest.mock("@strapi/utils", () => ({
  sanitize: { contentAPI: { output: jest.fn(async (rows) => rows) } },
}));

import controller from "../admin-dashboard";
import routeConfig from "../../routes/admin-dashboard";
import { ROLE_NAMES } from "../../../../utils/roles";

function createContext() {
  return {
    request: { body: {} },
    state: { auth: {}, user: { id: 1 } },
    body: null as any,
    set: jest.fn(),
  };
}

function installStrapi({
  raw,
  findMany,
  role = ROLE_NAMES.SUPERADMIN,
}: {
  raw: jest.Mock;
  findMany: jest.Mock;
  role?: string;
}) {
  (global as any).strapi = {
    db: { connection: { raw } },
    query: jest.fn((uid: string) =>
      uid === "plugin::users-permissions.user"
        ? {
            findOne: jest.fn().mockResolvedValue({
              id: 1,
              IsActive: true,
              blocked: false,
              role: { name: role },
            }),
          }
        : { findMany },
    ),
    contentType: jest.fn(() => ({})),
    log: { info: jest.fn() },
  };
}

describe("bounded admin dashboard summary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses the authenticated account capability policy", () => {
    expect(routeConfig.routes[0]).toEqual(
      expect.objectContaining({
        method: "POST",
        path: "/admin/dashboard-summary/query",
        config: {
          auth: { scope: [] },
          policies: [
            {
              name: "global::require-capability",
              config: { capability: "account.self.read" },
            },
          ],
        },
      }),
    );
  });

  it("returns one private summary with correctly named customer-account data", async () => {
    const raw = jest.fn().mockResolvedValue({
      rows: [
        {
          orders_total: "49518",
          done_orders_total: "1200",
          active_products_total: "2922",
          customer_accounts_total: "22966",
        },
      ],
    });
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 9,
        Status: "Done",
        Date: "2026-08-06T00:00:00.000Z",
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
        contract: { id: 3, Amount: 500 },
        user: { id: 2, phone: "synthetic", user_info: null },
      },
    ]);
    installStrapi({ raw, findMany });
    const ctx = createContext();

    await controller.query(ctx);

    expect(raw.mock.calls[0][0]).toContain("customer_accounts_total");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    );
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(ctx.body.data.metrics.customerAccountsTotal).toBe(22_966);
    expect(ctx.body.data.latestOrdersAmount).toBe(500);
  });

  it("keeps the bounded customer name and amount for roles with only order access", async () => {
    const { sanitize } = require("@strapi/utils");
    (sanitize.contentAPI.output as jest.Mock).mockImplementationOnce(
      async (rows: any[], _schema: unknown, options?: { auth?: unknown }) =>
        options?.auth
          ? rows.map((row) => ({ ...row, user: undefined, contract: undefined }))
          : rows,
    );
    const raw = jest.fn().mockResolvedValue({
      rows: [{ orders_total: "1", done_orders_total: "0" }],
    });
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 10,
        Status: "Started",
        createdAt: "2026-08-16T10:30:00.000Z",
        updatedAt: "2026-08-16T10:30:00.000Z",
        user: {
          id: 2,
          user_info: { id: 3, FirstName: "Ali", LastName: "Rezaei" },
        },
        contract: { id: 4, Amount: 250_000 },
      },
    ]);
    installStrapi({ raw, findMany, role: ROLE_NAMES.STORE_MANAGER });
    const ctx = createContext();

    await controller.query(ctx);

    expect(sanitize.contentAPI.output).toHaveBeenCalledWith(
      expect.any(Array),
      expect.anything(),
    );
    expect(sanitize.contentAPI.output.mock.calls.at(-1)).toHaveLength(2);
    expect(
      ctx.body.data.latestOrders[0].attributes.user.data.attributes.user_info.data.attributes,
    ).toEqual({ FirstName: "Ali", LastName: "Rezaei" });
    expect(ctx.body.data.latestOrders[0].attributes.contract.data.attributes.Amount).toBe(
      250_000,
    );
    expect(ctx.body.data.latestOrdersAmount).toBe(250_000);
  });

  it("does not scan or return customer-account totals for non-Superadmin roles", async () => {
    const raw = jest.fn().mockResolvedValue({
      rows: [{ orders_total: 1, done_orders_total: 0, active_products_total: 1 }],
    });
    installStrapi({
      raw,
      findMany: jest.fn().mockResolvedValue([]),
      role: ROLE_NAMES.FOUNDER,
    });
    const ctx = createContext();

    await controller.query(ctx);

    expect(raw.mock.calls[0][0]).not.toContain("FROM users");
    expect(ctx.body.data.metrics.customerAccountsTotal).toBeNull();
  });
});
