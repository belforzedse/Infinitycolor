const requireCapabilityMock = jest.fn();
const getUmamiBehaviorReportMock = jest.fn();
const getUmamiRealtimeReportMock = jest.fn();

jest.mock("../../../../utils/adminAuthorization", () => ({
  requireCapability: (...args: any[]) => requireCapabilityMock(...args),
}));

jest.mock("../../services/umami", () => ({
  UMAMI_DEFINITION_VERSION: "umami-infinity-v1",
  UMAMI_REPORT_TIMEZONE: "Asia/Tehran",
  isUmamiConfigured: jest.fn(() => true),
  normalizeRange: jest.fn((start?: string, end?: string) => ({
    startDate: start || "2026-08-09",
    endDate: end || "2026-08-31",
  })),
  normalizeUmamiFilters: jest.fn((input: Record<string, unknown> = {}) =>
    Object.fromEntries(
      Object.entries(input)
        .filter(([key, value]) => ["country", "utmCampaign"].includes(key) && value)
        .map(([key, value]) => [key, String(value)]),
    ),
  ),
  previousRange: jest.fn(() => ({ startDate: "2026-07-18", endDate: "2026-08-08" })),
  getUmamiBehaviorReport: (...args: any[]) => getUmamiBehaviorReportMock(...args),
  getUmamiRealtimeReport: (...args: any[]) => getUmamiRealtimeReportMock(...args),
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

describe("Umami behavior report endpoints", () => {
  it("registers the legacy controller actions as exact compatibility aliases", () => {
    const controller = loadController();
    expect(controller.trafficDashboard).toBe(controller.behaviorOverview);
    expect(controller.trafficRealtime).toBe(controller.behaviorRealtime);
    expect(controller.funnel).toBe(controller.behaviorConversion);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    requireCapabilityMock.mockResolvedValue({ user: { id: 1 } });
    (global as any).strapi = {
      db: { connection: { raw: jest.fn().mockResolvedValue({ rows: [] }) } },
      log: { warn: jest.fn() },
    };
  });

  it("returns source metadata and validated filters for acquisition", async () => {
    getUmamiBehaviorReportMock.mockResolvedValue({
      kind: "acquisition",
      range: { startDate: "2026-08-09", endDate: "2026-08-31" },
      summary: { visits: 12 },
      sections: { channel: [{ label: "direct", visits: 12 }] },
      errors: {},
    });
    const controller = loadController();
    const ctx = createCtx({
      query: {
        startDate: "2026-08-09",
        endDate: "2026-08-31",
        country: "IR",
        ignored: "never-forwarded",
      },
    });

    await controller.behaviorAcquisition(ctx);

    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(ctx.body.meta).toMatchObject({
      source: "umami",
      dataStart: "2026-08-09",
      status: "ok",
      currency: "Toman",
    });
    expect(getUmamiBehaviorReportMock).toHaveBeenCalledWith(
      "acquisition",
      { startDate: "2026-08-09", endDate: "2026-08-31" },
      expect.objectContaining({ filters: { country: "IR" } }),
    );
  });

  it("keeps unavailable provider data null instead of converting it to zero", async () => {
    getUmamiBehaviorReportMock.mockResolvedValue({
      kind: "overview",
      range: { startDate: "2026-08-09", endDate: "2026-08-31" },
      sections: {},
      errors: { source: "UMAMI_UNAVAILABLE" },
    });
    (global as any).strapi.db.connection.raw.mockRejectedValueOnce(new Error("outbox unavailable"));
    const controller = loadController();
    const ctx = createCtx();

    await controller.behaviorOverview(ctx);

    expect(ctx.body.data).toBeNull();
    expect(ctx.body.meta.status).toBe("unavailable");
  });

  it("keeps commerce totals visible when the conversion provider is unavailable", async () => {
    getUmamiBehaviorReportMock.mockResolvedValue({
      kind: "conversion",
      range: { startDate: "2026-08-09", endDate: "2026-08-31" },
      sections: {},
      errors: { source: "UMAMI_UNAVAILABLE" },
    });
    const raw = (global as any).strapi.db.connection.raw;
    raw.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes("storefront_orders")
          ? { rows: [{ total_orders: 3, paid_orders: 2, revenue_irr: 12_500_000 }] }
          : { rows: [] },
      ),
    );
    const controller = loadController();
    const ctx = createCtx({ query: { startDate: "2026-09-15", endDate: "2026-09-20" } });

    await controller.behaviorConversion(ctx);

    expect(ctx.body.meta.status).toBe("partial");
    expect(ctx.body.data.summary).toBeUndefined();
    expect(ctx.body.data.sections.commerce).toEqual({
      source: "commerce",
      scope: "storefront",
      currency: "Toman",
      range: { start: "2026-09-15", end: "2026-09-20" },
      paidOrders: 2,
      totalOrders: 3,
      revenueToman: 1_250_000,
    });
    // Umami only sees the new storefront; legacy WooCommerce orders stay out.
    const commerceSql = raw.mock.calls.find(([sql]: [string]) => sql.includes("storefront_orders"))[0];
    expect(commerceSql).toContain("o.external_source IS DISTINCT FROM 'woocommerce'");
    expect(ctx.body.meta.warnings).toContain(
      "Umami is unavailable; commerce totals remain current.",
    );
  });

  it("fetches and labels the exact previous period only when requested", async () => {
    getUmamiBehaviorReportMock.mockImplementation(async (_kind, range) => ({
      kind: "overview",
      range,
      summary: { visits: range.startDate === "2026-07-18" ? 8 : 12 },
      sections: { path: [] },
      errors: {},
    }));
    const controller = loadController();
    const ctx = createCtx({
      query: {
        startDate: "2026-08-09",
        endDate: "2026-08-31",
        comparison: "previous_period",
      },
    });

    await controller.behaviorOverview(ctx);

    expect(getUmamiBehaviorReportMock).toHaveBeenCalledTimes(2);
    expect(getUmamiBehaviorReportMock).toHaveBeenNthCalledWith(
      2,
      "overview",
      { startDate: "2026-07-18", endDate: "2026-08-08" },
      expect.anything(),
    );
    expect(ctx.body.data.comparison.summary.visits).toBe(8);
    expect(ctx.body.meta).toMatchObject({
      requestedRange: { start: "2026-08-09", end: "2026-08-31" },
      comparisonRange: { start: "2026-07-18", end: "2026-08-08" },
    });
  });

  it("bypasses a fresh historical cache entry when explicitly refreshed", async () => {
    getUmamiBehaviorReportMock.mockResolvedValue({
      kind: "overview",
      range: { startDate: "2026-08-09", endDate: "2026-08-31" },
      summary: { visits: 12 },
      sections: { path: [] },
      errors: {},
    });
    const controller = loadController();
    await controller.behaviorOverview(createCtx());
    await controller.behaviorOverview(createCtx({ query: { fresh: "1" } }));
    expect(getUmamiBehaviorReportMock).toHaveBeenCalledTimes(2);
  });

  it("caches realtime provider results for ten seconds", async () => {
    getUmamiRealtimeReportMock.mockResolvedValue({
      activeVisitors: 3,
      topPages: [{ path: "/products", visitors: 2 }],
    });
    const controller = loadController();
    const first = createCtx();
    const second = createCtx();

    await controller.behaviorRealtime(first);
    await controller.behaviorRealtime(second);

    expect(getUmamiRealtimeReportMock).toHaveBeenCalledTimes(1);
    expect(first.body.data.activeVisitors).toBe(3);
    expect(second.body.meta.cache).toBe("fresh");
  });

  it("stops before provider access when capability enforcement rejects", async () => {
    requireCapabilityMock.mockResolvedValue(null);
    const controller = loadController();
    const ctx = createCtx();

    await controller.behaviorOverview(ctx);

    expect(getUmamiBehaviorReportMock).not.toHaveBeenCalled();
  });
});
