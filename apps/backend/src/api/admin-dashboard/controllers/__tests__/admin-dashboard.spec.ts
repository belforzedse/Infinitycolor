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
  reserveCount = 4,
}: {
  raw: jest.Mock;
  findMany: jest.Mock;
  role?: string;
  reserveCount?: number;
}) {
  const count = jest.fn().mockResolvedValue(reserveCount);
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
        : { findMany, count },
    ),
    contentType: jest.fn(() => ({})),
    log: { info: jest.fn() },
  };
  return { count };
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
          today_orders_total: "9",
          today_paying_total: "1",
          today_inprogress_total: "3",
          today_completed_total: "4",
          today_shipped_total: "2",
          today_cancelled_total: "1",
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

    expect(raw.mock.calls.some(([sql]) => String(sql).includes("customer_accounts_total"))).toBe(
      true,
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    );
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(ctx.body.data.metrics.customerAccountsTotal).toBe(22_966);
    expect(ctx.body.data.todayOrderCounts).toEqual({
      all: 9,
      paying: 1,
      inprogress: 3,
      completed: 4,
      shipped: 2,
      cancelled: 1,
    });
    expect(ctx.body.data.activeReserveGroups).toBe(4);
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

    expect(raw.mock.calls.every(([sql]) => !String(sql).includes("FROM users"))).toBe(true);
    expect(ctx.body.data.metrics.customerAccountsTotal).toBeNull();
  });

  it("does not query or return order aggregates for Seller 1", async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [{ active_products_total: "5" }] });
    const findMany = jest.fn().mockResolvedValue([]);
    const { count } = installStrapi({
      raw,
      findMany,
      role: ROLE_NAMES.SELLER_1,
    });
    const ctx = createContext();

    await controller.query(ctx);

    expect(raw.mock.calls.every(([sql]) => !String(sql).includes("FROM orders"))).toBe(true);
    expect(raw.mock.calls.every(([sql]) => !String(sql).includes("today_shipped_total"))).toBe(
      true,
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    expect(ctx.body.data.metrics.ordersTotal).toBeNull();
    expect(ctx.body.data.todayOrderCounts).toBeNull();
    expect(ctx.body.data.activeReserveGroups).toBeNull();
    expect(ctx.body.data.latestOrders).toEqual([]);
    expect(ctx.body.data.authorizedModules.orders).toBe(false);
  });

  it("binds the current Tehran day as a half-open UTC range", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-12T10:00:00.000Z"));
    try {
      const raw = jest.fn().mockResolvedValue({ rows: [{}] });
      installStrapi({ raw, findMany: jest.fn().mockResolvedValue([]) });

      await controller.query(createContext());

      const orderCall = raw.mock.calls.find(([sql]) => String(sql).includes("FROM orders o"));
      expect(orderCall?.[1]?.slice(0, 2)).toEqual([
        "2026-09-11T20:30:00.000Z",
        "2026-09-12T20:30:00.000Z",
      ]);
      expect(String(orderCall?.[0])).toContain("o.date >= bounds.start_at");
      expect(String(orderCall?.[0])).toContain("o.date < bounds.end_at");
    } finally {
      jest.useRealTimers();
    }
  });
});
