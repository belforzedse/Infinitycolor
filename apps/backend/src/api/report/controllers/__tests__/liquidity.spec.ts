/**
 * `/reports/liquidity` and `/reports/gateway-liquidity`.
 *
 * Both endpoints read the SAME `paid_orders` set every other money page uses
 * (`productAnalytics.paidOrdersCte`) on the settlement clock, bucket in Tehran,
 * and return Toman. They used to sum every successful `contract_transactions`
 * row in the database (cancelled orders included), bucket by UTC day, and
 * group by the `payment_gateways` row linked to each transaction — a table
 * with duplicate rows, no Mellat row and 20k unlinked transactions — so the
 * liquidity figure matched nothing else on the site and the gateway pie
 * showed «نامشخص».
 */

const resolveJoinsMock = jest.fn();

jest.mock("../../services/umami", () => ({
  UMAMI_DEFINITION_VERSION: "umami-infinity-v1",
  UMAMI_REPORT_TIMEZONE: "Asia/Tehran",
  isUmamiConfigured: jest.fn(() => false),
  normalizeRange: jest.fn(() => ({ startDate: "2026-08-09", endDate: "2026-08-31" })),
  previousRange: jest.fn(() => ({ startDate: "2026-07-17", endDate: "2026-08-08" })),
  normalizeUmamiFilters: jest.fn(() => ({})),
  getUmamiBehaviorReport: jest.fn(),
  getUmamiRealtimeReport: jest.fn(),
}));

jest.mock("../../services/product-analytics", () => {
  const actual = jest.requireActual("../../services/product-analytics");
  return { ...actual, resolveJoins: (...args: any[]) => resolveJoinsMock(...args) };
});

const STUB_JOINS = {
  oiToOrder: "JOIN orders o ON true",
  oiToVariation: { join: "", idExpr: "oi.product_variation_id" },
  orderToContract: "JOIN contracts c ON true",
  contractToTx: "JOIN contract_transactions ct ON true",
  variationToProduct: "JOIN products p ON true",
  variationToStock: "",
  productToCategory: { join: "", titleExpr: "NULL::text" },
  orderToShipping: "",
  txSettlementGateway: true,
};

function loadController() {
  let controller: any;
  jest.isolateModules(() => {
    controller = require("../report").default;
  });
  return controller;
}

function createCtx(overrides: Partial<any> = {}) {
  return {
    state: { user: { id: 1 } },
    query: {},
    body: undefined,
    forbidden: jest.fn(),
    badRequest: jest.fn(),
    ...overrides,
  };
}

function mockStrapi(rawImpl: (sql: string, bindings: any[]) => Promise<any>) {
  (global as any).strapi = {
    query: () => ({
      findOne: jest.fn().mockResolvedValue({ id: 1, role: { name: "Superadmin" } }),
    }),
    db: {
      connection: {
        raw: jest.fn(rawImpl),
      },
    },
  };
}

const GATEWAY_ROWS = [
  { gateway: "SnappPay", orders_count: "3", total_orders_count: "4", settled_irr: "30000000", paid_orders_count: "4" },
  { gateway: "Wallet", orders_count: "2", total_orders_count: "1", settled_irr: "5000000", paid_orders_count: "4" },
  { gateway: "Mellat", orders_count: "0", total_orders_count: "2", settled_irr: "0", paid_orders_count: "4" },
];

function router(sql: string) {
  if (sql.includes("AS has_settlement")) return { rows: [{ has_settlement: true }] };
  // Already Toman on the order row, unlike every IRR settlement column here.
  if (sql.includes("AS shipping_total")) return { rows: [{ shipping_total: "420000" }] };
  if (sql.includes("paid_orders_count")) return { rows: GATEWAY_ROWS };
  if (sql.includes("FROM paid_orders") && sql.includes("to_char(")) {
    return {
      rows: [
        { bucket: "2026-09-15", total: "30000000", orders_count: "3" },
        { bucket: "2026-09-16", total: "5000000", orders_count: "1" },
      ],
    };
  }
  return { rows: [] };
}

describe("liquidity / gateway-liquidity", () => {
  beforeEach(() => {
    resolveJoinsMock.mockResolvedValue(STUB_JOINS);
  });
  afterEach(() => {
    delete (global as any).strapi;
  });

  it("liquidity: reads paid orders on the settlement clock, buckets in Tehran and returns Toman", async () => {
    const calls: Array<[string, any[]]> = [];
    mockStrapi(async (sql, bindings) => {
      calls.push([sql, bindings]);
      return router(sql);
    });

    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-09-14", end: "2026-09-16", interval: "day" } });
    await controller.liquidity(ctx);

    expect(ctx.badRequest).not.toHaveBeenCalled();
    const series = calls.find(([sql]) => sql.includes("to_char("))!;
    expect(series[0]).toContain("paid_orders AS (");
    expect(series[0]).toContain("AND ct.date BETWEEN ? AND ?");
    expect(series[0]).toContain("o.status IN ('Started', 'Shipment', 'Done')");
    expect(series[0]).toContain("AT TIME ZONE 'Asia/Tehran'");
    expect(series[0]).not.toContain("date_trunc(?");
    expect(series[1]).toHaveLength(2);

    expect(ctx.body.data.currency).toBe("Toman");
    expect(ctx.body.data.clock).toBe("settlement");
    expect(ctx.body.data.ordersDefinition).toBe("settled");
    expect(ctx.body.data.total).toBe(3_500_000);
    expect(ctx.body.data.ordersCount).toBe(4);
    // Every Tehran calendar day in the window, zero-filled.
    expect(ctx.body.data.series).toEqual([
      { bucket: "2026-09-14", total: 0, orders: 0 },
      { bucket: "2026-09-15", total: 3_000_000, orders: 3 },
      { bucket: "2026-09-16", total: 500_000, orders: 1 },
    ]);
  });

  it("liquidity: honours clock=order", async () => {
    const calls: string[] = [];
    mockStrapi(async (sql) => {
      calls.push(sql);
      return router(sql);
    });
    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-09-14", end: "2026-09-16", clock: "order" } });
    await controller.liquidity(ctx);
    expect(ctx.body.data.clock).toBe("order");
    expect(calls.find((sql) => sql.includes("to_char("))).toContain("AND o.date BETWEEN ? AND ?");
  });

  it("gateway-liquidity: runs the shared gateway breakdown and keeps the legacy row keys", async () => {
    const calls: Array<[string, any[]]> = [];
    mockStrapi(async (sql, bindings) => {
      calls.push([sql, bindings]);
      return router(sql);
    });

    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-09-14", end: "2026-09-30" } });
    await controller.gatewayLiquidity(ctx);

    expect(ctx.badRequest).not.toHaveBeenCalled();
    const breakdown = calls.find(([sql]) => sql.includes("paid_orders_count"))!;
    expect(breakdown[0]).toContain("NULLIF(ct.settlement_gateway, '')");
    expect(breakdown[0]).toContain("FULL OUTER JOIN all_orders");
    expect(breakdown[0]).not.toContain("information_schema");
    expect(breakdown[1]).toHaveLength(4);

    expect(ctx.body.data.currency).toBe("Toman");
    expect(ctx.body.data.paidOrdersCount).toBe(4);
    expect(ctx.body.data.rows).toEqual([
      expect.objectContaining({ gatewayId: null, gatewayTitle: "اسنپ‌پی", gateway: "SnappPay", total: 3_000_000, ordersCount: 3, sharePct: 85.71 }),
      expect.objectContaining({ gatewayTitle: "کیف پول", gateway: "Wallet", total: 500_000, ordersCount: 2 }),
      expect.objectContaining({ gatewayTitle: "ملت", gateway: "Mellat", total: 0, ordersCount: 0, totalOrdersCount: 2 }),
    ]);
    expect(ctx.body.data.dataQualityWarnings).toEqual([
      expect.objectContaining({ code: "GATEWAY_NO_SETTLED_ORDERS", gateway: "Mellat", ordersCount: 2 }),
    ]);
  });

  it("gateway-liquidity: returns the shipping term that reconciles cash with «فروش ناخالص»", async () => {
    const calls: Array<[string, any[]]> = [];
    mockStrapi(async (sql, bindings) => {
      calls.push([sql, bindings]);
      return router(sql);
    });

    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-09-14", end: "2026-09-30" } });
    await controller.gatewayLiquidity(ctx);

    const shipping = calls.find(([sql]) => sql.includes("AS shipping_total"))!;
    // Same paid_orders set as the gateway rows, so the subtraction is exact.
    expect(shipping[0]).toContain("paid_orders AS (");
    expect(shipping[0]).toContain("AND ct.date BETWEEN ? AND ?");
    expect(shipping[0]).toContain("JOIN orders o ON o.id = po.order_id");
    expect(shipping[1]).toHaveLength(2);

    // Toman passthrough: irrToToman would have made this 42,000.
    expect(ctx.body.data.shippingRevenue).toBe(420_000);

    const gatewaySum = ctx.body.data.rows.reduce(
      (sum: number, row: { total: number }) => sum + row.total,
      0,
    );
    expect(gatewaySum - ctx.body.data.shippingRevenue).toBe(3_080_000);
  });

  it("gateway-liquidity: requires the finance-report capability", async () => {
    (global as any).strapi = {
      query: () => ({
        findOne: jest.fn().mockResolvedValue({ id: 1, role: { name: "Store Manager" } }),
      }),
      db: { connection: { raw: jest.fn() } },
    };
    const controller = loadController();
    const ctx = createCtx();
    await controller.gatewayLiquidity(ctx);
    expect(ctx.forbidden).toHaveBeenCalledWith("You do not have permission to perform this action");
  });

  it("gateway-liquidity reconciles with liquidity's total for an identical window", async () => {
    mockStrapi(async (sql) => router(sql));
    const controller = loadController();
    const gatewayCtx = createCtx({ query: { start: "2026-09-14", end: "2026-09-16" } });
    const liquidityCtx = createCtx({ query: { start: "2026-09-14", end: "2026-09-16" } });
    await controller.gatewayLiquidity(gatewayCtx);
    await controller.liquidity(liquidityCtx);

    const gatewaySum = gatewayCtx.body.data.rows.reduce(
      (sum: number, row: { total: number }) => sum + row.total,
      0,
    );
    expect(gatewaySum).toBe(liquidityCtx.body.data.total);
  });
});
