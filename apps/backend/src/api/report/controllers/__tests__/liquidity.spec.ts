/**
 * Toman normalization for the legacy `/reports/liquidity` and
 * `/reports/gateway-liquidity` endpoints (decision D4,
 * docs/analytics/analytics-decisions.md).
 *
 * Both endpoints read `contract_transactions.amount`, which is stored in IRR, while
 * every other report endpoint (`/reports/products/*`) already returns Toman. This is
 * the named Phase 1 acceptance gate: for known IRR inputs, the endpoint must return
 * exactly `irr / 10`, with an explicit `currency: "Toman"` field, and nothing else
 * about the query (date basis, grouping, gateway attribution) may change.
 */

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

describe("liquidity/gateway-liquidity Toman normalization", () => {
  afterEach(() => {
    delete (global as any).strapi;
  });

  it("liquidity: converts the IRR total and series to Toman and stamps currency", async () => {
    // Two settled IRR transactions net to 19,500,000 IRR = 1,950,000 Toman.
    const seriesRow = { bucket: "2026-05-05T00:00:00.000Z", total: 19_500_000 };
    const totalRow = { total: 19_500_000 };
    mockStrapi(async (sql: string) => {
      if (sql.includes("date_trunc(?, ct.date)")) return { rows: [seriesRow] };
      if (sql.includes("SELECT COALESCE(SUM")) return { rows: [totalRow] };
      return { rows: [] };
    });

    const controller = loadController();
    const ctx = createCtx({
      query: { start: "2026-05-01", end: "2026-05-31", interval: "day" },
    });
    await controller.liquidity(ctx);

    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(ctx.body.data.currency).toBe("Toman");
    expect(ctx.body.data.total).toBe(19_500_000 / 10);
    expect(ctx.body.data.series).toEqual([{ bucket: seriesRow.bucket, total: 1_950_000 }]);
  });

  it("liquidity: negative net (returns exceeding gateway settlement) still divides cleanly by 10", async () => {
    mockStrapi(async (sql: string) => {
      if (sql.includes("date_trunc(?, ct.date)")) return { rows: [] };
      if (sql.includes("SELECT COALESCE(SUM")) return { rows: [{ total: -5_000_000 }] };
      return { rows: [] };
    });

    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-05-01", end: "2026-05-31" } });
    await controller.liquidity(ctx);

    expect(ctx.body.data.total).toBe(-500_000);
    expect(ctx.body.data.currency).toBe("Toman");
  });

  it("gateway-liquidity: wraps rows under `rows`, converts each to Toman, keeps gateway attribution", async () => {
    mockStrapi(async (sql: string) => {
      if (sql.includes("information_schema.tables")) return { rows: [] }; // no link table -> direct FK path
      if (sql.includes("SELECT pg.id AS gateway_id")) {
        return {
          rows: [
            { gateway_id: 1, title: "Mellat", total: 30_000_000 },
            { gateway_id: 2, title: "ZarinPal", total: 5_000_000 },
          ],
        };
      }
      return { rows: [] };
    });

    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-05-01", end: "2026-05-31" } });
    await controller.gatewayLiquidity(ctx);

    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(ctx.body.data.currency).toBe("Toman");
    expect(ctx.body.data.rows).toEqual([
      { gatewayId: 1, gatewayTitle: "Mellat", total: 3_000_000 },
      { gatewayId: 2, gatewayTitle: "ZarinPal", total: 500_000 },
    ]);
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

  it("gateway-liquidity: joins through the link table with LEFT JOIN, not INNER, so an unlinked successful transaction is kept", async () => {
    // Regression test: this endpoint used to INNER JOIN through the link table,
    // silently dropping any `contract_transactions` row with no `payment_gateway`
    // relation set. That made `/sales/gateways` under-count relative to
    // `/sales/liquidity`, which sums every successful transaction unconditionally.
    let capturedQuery = "";
    mockStrapi(async (sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return { rows: [{ table_name: "contract_transactions_payment_gateway_links" }] };
      }
      if (sql.includes("information_schema.columns")) {
        return {
          rows: [{ column_name: "contract_transaction_id" }, { column_name: "payment_gateway_id" }],
        };
      }
      if (sql.includes("SELECT pg.id AS gateway_id")) {
        capturedQuery = sql;
        return {
          rows: [
            { gateway_id: 1, title: "Mellat", total: 30_000_000 },
            { gateway_id: null, title: "نامشخص", total: 5_000_000 },
          ],
        };
      }
      return { rows: [] };
    });

    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-05-01", end: "2026-05-31" } });
    await controller.gatewayLiquidity(ctx);

    const normalized = capturedQuery.replace(/\s+/g, " ").trim();
    expect(normalized).toContain(
      "LEFT JOIN contract_transactions_payment_gateway_links l ON l.contract_transaction_id = ct.id " +
        "LEFT JOIN payment_gateways pg ON pg.id = l.payment_gateway_id",
    );
    expect(ctx.body.data.rows).toEqual([
      { gatewayId: 1, gatewayTitle: "Mellat", total: 3_000_000 },
      { gatewayId: null, gatewayTitle: "نامشخص", total: 500_000 },
    ]);
  });

  it("gateway-liquidity reconciles with liquidity's total for an identical date range", async () => {
    // Same WHERE predicate (`ct.status = 'Success' AND ct.date BETWEEN ? AND ?`),
    // no join dropping rows: summing every gateway-liquidity row (including the
    // unassigned bucket) must equal the unconditional liquidity total.
    mockStrapi(async (sql: string) => {
      if (sql.includes("information_schema.tables")) return { rows: [] };
      if (sql.includes("SELECT pg.id AS gateway_id")) {
        return {
          rows: [
            { gateway_id: 1, title: "Mellat", total: 30_000_000 },
            { gateway_id: null, title: "نامشخص", total: 5_000_000 },
          ],
        };
      }
      if (sql.includes("SELECT COALESCE(SUM")) return { rows: [{ total: 35_000_000 }] };
      if (sql.includes("date_trunc(?, ct.date)")) return { rows: [] };
      return { rows: [] };
    });

    const controller = loadController();
    const gatewayCtx = createCtx({ query: { start: "2026-05-01", end: "2026-05-31" } });
    const liquidityCtx = createCtx({ query: { start: "2026-05-01", end: "2026-05-31" } });
    await Promise.all([
      controller.gatewayLiquidity(gatewayCtx),
      controller.liquidity(liquidityCtx),
    ]);

    const gatewaySum = gatewayCtx.body.data.rows.reduce((sum: number, r: any) => sum + r.total, 0);
    expect(gatewaySum).toBe(liquidityCtx.body.data.total);
  });
});
