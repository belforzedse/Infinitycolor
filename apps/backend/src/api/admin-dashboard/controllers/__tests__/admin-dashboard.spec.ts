jest.mock("@strapi/utils", () => ({
  sanitize: { contentAPI: { output: jest.fn(async (rows) => rows) } },
}));
jest.mock("../../../../utils/roles", () => {
  const actual = jest.requireActual("../../../../utils/roles");
  return { ...actual, resolveUserRoleName: jest.fn() };
});

import controller from "../admin-dashboard";
import routeConfig from "../../routes/admin-dashboard";
import { ROLE_NAMES, STORE_MANAGER_PLUS_ROLES, resolveUserRoleName } from "../../../../utils/roles";

const mockResolveRole = resolveUserRoleName as jest.Mock;

function createContext() {
  return {
    request: { body: {} },
    state: { auth: {}, user: { id: 1 } },
    body: null as any,
    set: jest.fn(),
  };
}

describe("bounded admin dashboard summary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses the operational role policy", () => {
    expect(routeConfig.routes[0]).toEqual(
      expect.objectContaining({
        method: "POST",
        path: "/admin/dashboard-summary/query",
        config: {
          auth: { scope: [] },
          policies: [
            {
              name: "global::role-based",
              config: { roles: STORE_MANAGER_PLUS_ROLES },
            },
          ],
        },
      }),
    );
  });

  it("returns one private summary with correctly named customer-account data", async () => {
    mockResolveRole.mockResolvedValue(ROLE_NAMES.SUPERADMIN);
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
    (global as any).strapi = {
      db: { connection: { raw } },
      query: jest.fn(() => ({ findMany })),
      contentType: jest.fn(() => ({})),
      log: { info: jest.fn() },
    };
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

  it("does not scan or return customer-account totals for non-Superadmin roles", async () => {
    mockResolveRole.mockResolvedValue(ROLE_NAMES.FOUNDER);
    const raw = jest.fn().mockResolvedValue({
      rows: [{ orders_total: 1, done_orders_total: 0, active_products_total: 1 }],
    });
    (global as any).strapi = {
      db: { connection: { raw } },
      query: jest.fn(() => ({ findMany: jest.fn().mockResolvedValue([]) })),
      contentType: jest.fn(() => ({})),
      log: { info: jest.fn() },
    };
    const ctx = createContext();

    await controller.query(ctx);

    expect(raw.mock.calls[0][0]).not.toContain("FROM users");
    expect(ctx.body.data.metrics.customerAccountsTotal).toBeNull();
  });
});
