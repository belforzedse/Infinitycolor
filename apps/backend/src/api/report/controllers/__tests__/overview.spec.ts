export {}; // module scope so test-local mocks don't collide with sibling specs

const fetchUserWithRoleMock = jest.fn();
const roleIsAllowedMock = jest.fn();
const resolveJoinsMock = jest.fn();
const getMatomoVisitsSummaryMock = jest.fn();

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

jest.mock("../../services/matomo", () => ({
  normalizeRange: jest.fn((start?: string, end?: string) => ({
    startDate: start || "2026-01-01",
    endDate: end || "2026-01-31",
  })),
  previousRange: jest.fn((range: { startDate: string; endDate: string }) => ({
    startDate: "2025-12-01",
    endDate: "2025-12-31",
  })),
  getMatomoVisitsSummary: (...args: any[]) => getMatomoVisitsSummaryMock(...args),
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
  gross: "1000000",
  units: "4",
  orders_count: "3",
  discounts: "50000",
  refund_irr: "2400000", // -> 240,000 Toman
};

const RECONCILIATION_ROW = {
  bucket_date: "2026-01-30T00:00:00.000Z",
  status: "matched",
  orders_delta: "0",
  revenue_ratio: "1.02",
  possible_currency_mismatch: false,
  computed_at: "2026-01-31T00:20:00.000Z",
};

function rawRouter(sql: string) {
  if (sql.includes("SUM(line_gross) FROM itemized")) return { rows: [PERIOD_ROW] };
  if (sql.includes("analytics_reconciliation_daily")) return { rows: [RECONCILIATION_ROW] };
  return { rows: [] };
}

function createStrapi() {
  return { db: { connection: { raw: jest.fn(async (sql: string) => rawRouter(sql)) } } };
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

  it("computes store-wide sales KPIs (IRR->Toman, net = gross - discounts - refunds)", async () => {
    getMatomoVisitsSummaryMock.mockResolvedValue(null);
    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-01-01", end: "2026-01-31" } });

    await controller.overview(ctx);

    expect(ctx.badRequest).not.toHaveBeenCalled();
    const { sales } = ctx.body.data;
    expect(sales.gross.current).toBe(1_000_000);
    expect(sales.refunds.current).toBe(240_000);
    expect(sales.net.current).toBe(710_000);
    // current and previous read the same mocked row -> zero change
    expect(sales.gross.change).toBe(0);
  });

  it("reports traffic as null (not zeroed) when Matomo is unavailable", async () => {
    getMatomoVisitsSummaryMock.mockResolvedValue(null);
    const controller = loadController();
    const ctx = createCtx();

    await controller.overview(ctx);

    expect(ctx.body.data.traffic).toBeNull();
  });

  it("computes traffic deltas when Matomo answers for both periods", async () => {
    getMatomoVisitsSummaryMock
      .mockResolvedValueOnce({ visits: 500, visitors: 300, pageviews: 1200 }) // current
      .mockResolvedValueOnce({ visits: 400, visitors: 250, pageviews: 1000 }); // previous
    const controller = loadController();
    const ctx = createCtx();

    await controller.overview(ctx);

    expect(ctx.body.data.traffic).toEqual({
      visits: { current: 500, previous: 400, change: 100, changePct: 25 },
      visitors: { current: 300, previous: 250, change: 50, changePct: 20 },
      pageviews: { current: 1200, previous: 1000, change: 200, changePct: 20 },
    });
  });

  it("surfaces the latest reconciliation row as a trust signal", async () => {
    getMatomoVisitsSummaryMock.mockResolvedValue(null);
    const controller = loadController();
    const ctx = createCtx();

    await controller.overview(ctx);

    expect(ctx.body.data.reconciliation).toEqual({
      bucketDate: "2026-01-30",
      status: "matched",
      ordersDelta: 0,
      revenueRatio: 1.02,
      possibleCurrencyMismatch: false,
      computedAt: "2026-01-31T00:20:00.000Z",
    });
  });

  it("blocks a Customer", async () => {
    fetchUserWithRoleMock.mockResolvedValue({ role: { name: "Customer" } });
    roleIsAllowedMock.mockReturnValue(false);
    const controller = loadController();
    const ctx = createCtx();

    await controller.overview(ctx);

    expect(ctx.forbidden).toHaveBeenCalled();
    expect(resolveJoinsMock).not.toHaveBeenCalled();
  });
});
