export {}; // module scope so test-local mocks don't collide with sibling specs

const fetchUserWithRoleMock = jest.fn();
const roleIsAllowedMock = jest.fn();
const resolveJoinsMock = jest.fn();

jest.mock("../../../../utils/roles", () => ({
  ROLE_NAMES: {
    SUPERADMIN: "Superadmin",
    FOUNDER: "Founder",
    STORE_MANAGER: "Store manager",
    EDITOR: "Editor",
    CUSTOMER: "Customer",
  },
  fetchUserWithRole: (...args: any[]) => fetchUserWithRoleMock(...args),
  roleIsAllowed: (...args: any[]) => roleIsAllowedMock(...args),
}));

jest.mock("../../services/umami", () => ({
  UMAMI_DEFINITION_VERSION: "umami-infinity-v1",
  UMAMI_REPORT_TIMEZONE: "Asia/Tehran",
  isUmamiConfigured: jest.fn(() => false),
  normalizeUmamiFilters: jest.fn(() => ({})),
  getUmamiBehaviorReport: jest.fn(),
  getUmamiRealtimeReport: jest.fn(),
  normalizeRange: jest.fn((start?: string, end?: string) => ({
    startDate: start || "2026-09-14",
    endDate: end || "2026-09-30",
  })),
  previousRange: jest.fn((range: { startDate: string; endDate: string }) => ({
    startDate: "2026-08-14",
    endDate: "2026-09-12",
  })),
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
  variationToStock: "LEFT JOIN product_stocks ps ON true",
  productToCategory: { join: "LEFT JOIN product_categories pc ON true", titleExpr: "pc.title" },
  orderToShipping: "LEFT JOIN shippings s ON true",
};

const PERIOD_ROW = {
  gross: "1000000", // merchandise lines only
  units: "4",
  orders_count: "3",
  discounts: "50000",
  refund_irr: "2400000", // -> 240,000 Toman
  shipping: "120000", // orders.shipping_cost, already Toman
};

const DELIVERY_ROW = {
  total: "7",
  pending: "1",
  processing: "0",
  dead_letter: "0",
  oldest_pending_at: "2026-08-09T10:00:00.000Z",
  last_sent_at: "2026-08-09T09:59:00.000Z",
};

const SERIES_ROWS = [
  { bucket: "2026-09-15", gross: "600000", units: "3", orders_count: "2", discounts: "20000", refund_irr: "0", shipping: "80000" },
  { bucket: "2026-09-17", gross: "400000", units: "1", orders_count: "1", discounts: "30000", refund_irr: "2400000", shipping: "40000" },
];

const WEEKDAY_ROWS = [
  { dow: 5, hour: 22, count: "4" },
  { dow: 1, hour: 10, count: "1" },
];

function rawRouter(sql: string) {
  if (sql.includes("SUM(line_gross) FROM itemized")) return { rows: [PERIOD_ROW] };
  if (sql.includes("items_b")) return { rows: SERIES_ROWS };
  if (sql.includes("EXTRACT(DOW")) return { rows: WEEKDAY_ROWS };
  if (sql.includes("FROM analytics_outbox")) return { rows: [DELIVERY_ROW] };
  return { rows: [] };
}

function createStrapi() {
  return {
    query: () => ({
      findOne: jest.fn().mockResolvedValue({ id: 1, role: { name: "Finance" } }),
    }),
    db: { connection: { raw: jest.fn(async (sql: string) => rawRouter(sql)) } },
  };
}

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

describe("report.overview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveJoinsMock.mockResolvedValue(STUB_JOINS);
    (global as any).strapi = createStrapi();
    fetchUserWithRoleMock.mockResolvedValue({ role: { name: "Store manager" } });
    roleIsAllowedMock.mockReturnValue(true);
  });

  it("computes store-wide sales KPIs (IRR->Toman, gross includes shipping, net does not)", async () => {
    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-09-14", end: "2026-09-30" } });

    await controller.overview(ctx);

    expect(ctx.badRequest).not.toHaveBeenCalled();
    const { sales } = ctx.body.data;
    // Store-wide gross is what the orders were written for: 1,000,000 of lines
    // plus the 120,000 delivery fee (decision D16).
    expect(sales.shipping.current).toBe(120_000);
    expect(sales.gross.current).toBe(1_120_000);
    expect(sales.refunds.current).toBe(240_000);
    // ...but net stays merchandise: gross - shipping - discounts - refunds.
    expect(sales.net.current).toBe(710_000);
    expect(
      sales.gross.current -
        sales.shipping.current -
        sales.discounts.current -
        sales.refunds.current,
    ).toBe(sales.net.current);
    // current and previous read the same mocked row -> zero change
    expect(sales.gross.change).toBe(0);
  });

  it("keeps shipping out of the per-product gross it shares with the product reports", async () => {
    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-09-14", end: "2026-09-30" } });

    await controller.overview(ctx);

    // The one SQL statement must read orders.shipping_cost off paid_orders, never
    // through irrToToman (the column is stored in Toman).
    const raw = (global as any).strapi.db.connection.raw as jest.Mock;
    const periodSql = raw.mock.calls
      .map(([sql]: [string]) => sql)
      .find((sql: string) => sql.includes("SUM(line_gross) FROM itemized"));
    expect(periodSql).toContain("SUM(o.shipping_cost)");
    expect(periodSql).toContain("JOIN orders o ON o.id = po.order_id");
  });

  it("floors both the current and the previous window at ۲۳ شهریور ۱۴۰۵", async () => {
    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-09-01", end: "2026-09-30" } });

    await controller.overview(ctx);

    const floorMs = new Date("2026-09-13T20:30:00.000Z").getTime();
    const raw = (global as any).strapi.db.connection.raw as jest.Mock;
    const bound = raw.mock.calls.flatMap(([, bindings]: [string, unknown[] | undefined]) =>
      (bindings ?? []).filter((value): value is Date => value instanceof Date),
    );
    expect(bound.length).toBeGreaterThan(0);
    for (const value of bound) expect(value.getTime()).toBeGreaterThanOrEqual(floorMs - 1);
    // The requested window is cut at the floor; the mocked previous window
    // (2026-08-14..2026-09-12) lies wholly before it and is echoed as the
    // empty window, end before start.
    expect(ctx.body.data.range).toEqual({ start: "2026-09-14", end: "2026-09-30" });
    expect(ctx.body.data.previous).toEqual({ start: "2026-09-14", end: "2026-09-13" });
  });

  it("adds the same figures per Tehran day, with empty days as true zeros", async () => {
    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-09-14", end: "2026-09-20" } });

    await controller.overview(ctx);

    const { series } = ctx.body.data;
    expect(series.grouping).toBe("day");
    expect(series.points.map((point: { bucket: string }) => point.bucket)).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
    ]);
    // Gross carries shipping like the KPI; net is lines - discounts - refunds (IRR -> Toman).
    expect(series.points[1]).toEqual({
      bucket: "2026-09-15",
      gross: 680_000,
      shipping: 80_000,
      net: 580_000,
      units: 3,
      orders: 2,
      discounts: 20_000,
      refunds: 0,
    });
    expect(series.points[3]).toMatchObject({ gross: 440_000, net: 130_000, refunds: 240_000 });
    expect(series.points[0]).toMatchObject({ gross: 0, orders: 0 });
  });

  it("adds when paid orders are placed as a Tehran weekday × hour grid", async () => {
    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-09-14", end: "2026-09-27" } });

    await controller.overview(ctx);

    const { weekly } = ctx.body.data;
    expect(weekly.timezone).toBe("Asia/Tehran");
    expect(weekly.firstDay).toBe("sunday");
    expect(weekly.counts).toHaveLength(7);
    expect(weekly.counts[5][22]).toBe(4);
    expect(weekly.counts[1][10]).toBe(1);
    expect(weekly.counts[0][0]).toBe(0);
    // 14–27 Sep 2026: two of every weekday.
    expect(weekly.days).toEqual([2, 2, 2, 2, 2, 2, 2]);
    const raw = (global as any).strapi.db.connection.raw as jest.Mock;
    const gridSql = raw.mock.calls.map(([sql]: [string]) => sql).find((sql: string) => sql.includes("EXTRACT(DOW"));
    expect(gridSql).toContain("AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tehran'");
  });

  it("keeps behavioral reporting in its purpose-specific workspace", async () => {
    const controller = loadController();
    const ctx = createCtx();

    await controller.overview(ctx);

    expect(ctx.body.data).not.toHaveProperty("traffic");
  });

  it("surfaces durable analytics delivery health as a trust signal", async () => {
    const controller = loadController();
    const ctx = createCtx();

    await controller.overview(ctx);

    expect(ctx.body.data.analyticsDelivery).toEqual({
      status: "pending",
      total: 7,
      pending: 1,
      processing: 0,
      deadLetter: 0,
      oldestPendingAt: "2026-08-09T10:00:00.000Z",
      lastSentAt: "2026-08-09T09:59:00.000Z",
    });
  });

  it("blocks a Customer", async () => {
    (global as any).strapi = {
      ...createStrapi(),
      query: () => ({
        findOne: jest.fn().mockResolvedValue({ id: 1, role: { name: "Customer" } }),
      }),
    };
    const controller = loadController();
    const ctx = createCtx();

    await controller.overview(ctx);

    expect(ctx.forbidden).toHaveBeenCalled();
    expect(resolveJoinsMock).not.toHaveBeenCalled();
  });
});
