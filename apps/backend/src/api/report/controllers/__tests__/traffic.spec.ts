const requireCapabilityMock = jest.fn();
const getUmamiBehaviorReportMock = jest.fn();
const getUmamiRealtimeReportMock = jest.fn();
const getUmamiConversionDetailMock = jest.fn();

jest.mock("../../../../utils/adminAuthorization", () => ({
  requireCapability: (...args: any[]) => requireCapabilityMock(...args),
}));

jest.mock("../../services/umami", () => {
  const actual = jest.requireActual("../../services/umami");
  return {
  UMAMI_DEFINITION_VERSION: "umami-infinity-v1",
  UMAMI_CONTRACT_VERSION: "3.3.1",
  UMAMI_REPORT_TIMEZONE: "Asia/Tehran",
  umamiDataStart: () => "2026-08-09",
  seriesUnitForRange: actual.seriesUnitForRange,
  seriesKeys: actual.seriesKeys,
  parseConversionDetail: actual.parseConversionDetail,
  conversionDetailKey: actual.conversionDetailKey,
  getUmamiConversionDetail: (...args: any[]) => getUmamiConversionDetailMock(...args),
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
  };
});

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
        sql.includes("AS bucket")
          ? { rows: [{ bucket: "2026-09-16", paid_orders: 2, revenue_irr: 12_500_000 }] }
          : sql.includes("storefront_orders")
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
      series: {
        unit: "day",
        points: [
          { t: "2026-09-15", paidOrders: 0, revenueToman: 0 },
          { t: "2026-09-16", paidOrders: 2, revenueToman: 1_250_000 },
          { t: "2026-09-17", paidOrders: 0, revenueToman: 0 },
          { t: "2026-09-18", paidOrders: 0, revenueToman: 0 },
          { t: "2026-09-19", paidOrders: 0, revenueToman: 0 },
          { t: "2026-09-20", paidOrders: 0, revenueToman: 0 },
        ],
      },
    });
    // Without Umami the purchase goal is unknown, so tracking is unavailable, not "0%".
    expect(ctx.body.data.sections.purchaseTracking).toEqual({
      umamiPurchaseSessions: null,
      commercePaidOrders: 2,
      coverage: null,
      status: "unavailable",
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

  it("buckets the commerce series in Tehran and leaves days before the financial floor null", async () => {
    getUmamiBehaviorReportMock.mockResolvedValue({
      kind: "conversion",
      range: { startDate: "2026-09-12", endDate: "2026-09-15" },
      summary: { visitors: 10 },
      sections: { purchaseGoal: { num: 1, total: 10 } },
      errors: {},
    });
    const raw = (global as any).strapi.db.connection.raw;
    raw.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes("AS bucket")
          ? { rows: [{ bucket: "2026-09-15", paid_orders: 1, revenue_irr: 10_000 }] }
          : { rows: [{ total_orders: 1, paid_orders: 1, revenue_irr: 10_000 }] },
      ),
    );
    const controller = loadController();
    const ctx = createCtx({ query: { startDate: "2026-09-12", endDate: "2026-09-15" } });

    await controller.behaviorConversion(ctx);

    const seriesSql = raw.mock.calls.find(([sql]: [string]) => sql.includes("AS bucket"))[0];
    expect(seriesSql).toContain("(o.date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tehran'");
    expect(seriesSql).toContain("o.external_source IS DISTINCT FROM 'woocommerce'");
    expect(ctx.body.data.sections.commerce.series.points).toEqual([
      { t: "2026-09-12", paidOrders: null, revenueToman: null },
      { t: "2026-09-13", paidOrders: null, revenueToman: null },
      { t: "2026-09-14", paidOrders: 0, revenueToman: 0 },
      { t: "2026-09-15", paidOrders: 1, revenueToman: 1_000 },
    ]);
  });

  it.each([
    [{ num: 0, total: 900 }, 40, "not_live"],
    [{ num: 12, total: 900 }, 40, "degraded"],
    [{ num: 34, total: 900 }, 40, "live"],
    [{ num: 0, total: 900 }, 3, "unknown"],
  ])(
    "reconciles Umami purchase sessions %j against %i paid orders as %s",
    async (purchaseGoal, paidOrders, status) => {
      getUmamiBehaviorReportMock.mockResolvedValue({
        kind: "conversion",
        range: { startDate: "2026-09-15", endDate: "2026-09-20" },
        summary: { visitors: 900 },
        sections: { purchaseGoal },
        errors: {},
      });
      (global as any).strapi.db.connection.raw.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes("AS bucket")
            ? { rows: [] }
            : { rows: [{ total_orders: paidOrders, paid_orders: paidOrders, revenue_irr: 0 }] },
        ),
      );
      const controller = loadController();
      const ctx = createCtx({ query: { startDate: "2026-09-15", endDate: "2026-09-20" } });

      await controller.behaviorConversion(ctx);

      expect(ctx.body.data.sections.purchaseTracking).toMatchObject({
        umamiPurchaseSessions: purchaseGoal.num,
        commercePaidOrders: paidOrders,
        status,
      });
    },
  );

  it("reconciles against the unfiltered purchase count when a segment filter is active", async () => {
    getUmamiBehaviorReportMock.mockResolvedValue({
      kind: "conversion",
      range: { startDate: "2026-09-15", endDate: "2026-09-20" },
      summary: { visitors: 900 },
      // Laptops alone bought twice; the whole storefront recorded 34 buyers.
      sections: { purchaseGoal: { num: 2, total: 90 }, purchaseGoalAll: { num: 34, total: 1800 } },
      errors: {},
    });
    (global as any).strapi.db.connection.raw.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes("AS bucket")
          ? { rows: [] }
          : { rows: [{ total_orders: 40, paid_orders: 40, revenue_irr: 0 }] },
      ),
    );
    const controller = loadController();
    const ctx = createCtx({ query: { startDate: "2026-09-15", endDate: "2026-09-20", device: "laptop" } });

    await controller.behaviorConversion(ctx);

    expect(ctx.body.data.sections.purchaseTracking).toMatchObject({
      umamiPurchaseSessions: 34,
      commercePaidOrders: 40,
      status: "live",
    });
    // The segment's own goal is still what its conversion rate uses.
    expect(ctx.body.data.sections.purchaseGoal).toEqual({ num: 2, total: 90 });
  });

  it("serves a conversion drill-down without commerce, comparison, or the full report", async () => {
    getUmamiConversionDetailMock.mockResolvedValue({
      kind: "conversion-breakdown",
      range: { startDate: "2026-09-15", endDate: "2026-09-20" },
      sections: { segments: [{ value: "mobile", visitors: 10, steps: [] }] },
      errors: {},
    });
    const controller = loadController();
    const ctx = createCtx({
      query: {
        startDate: "2026-09-15",
        endDate: "2026-09-20",
        comparison: "previous_period",
        detail: "breakdown",
        funnel: "checkout",
        dimension: "os",
      },
    });

    await controller.behaviorConversion(ctx);

    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(getUmamiBehaviorReportMock).not.toHaveBeenCalled();
    expect(getUmamiConversionDetailMock).toHaveBeenCalledTimes(1);
    expect(getUmamiConversionDetailMock).toHaveBeenCalledWith(
      { detail: "breakdown", funnel: "checkout", dimension: "os" },
      { startDate: "2026-09-15", endDate: "2026-09-20" },
      expect.anything(),
    );
    expect((global as any).strapi.db.connection.raw).not.toHaveBeenCalled();
    expect(ctx.body.data.sections.segments[0].value).toBe("mobile");
    expect(ctx.body.data.comparison).toBeUndefined();
    expect(ctx.body.meta.provider).toEqual({ name: "Umami", contractVersion: "3.3.1" });
  });

  it("rejects a drill-down outside the allowlists instead of serving the full report", async () => {
    const controller = loadController();
    const ctx = createCtx({ query: { detail: "breakdown", dimension: "utmSource" } });

    await controller.behaviorConversion(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith("INVALID_CONVERSION_DETAIL", expect.anything());
    expect(getUmamiConversionDetailMock).not.toHaveBeenCalled();
    expect(getUmamiBehaviorReportMock).not.toHaveBeenCalled();
  });

  it("stops before provider access when capability enforcement rejects", async () => {
    requireCapabilityMock.mockResolvedValue(null);
    const controller = loadController();
    const ctx = createCtx();

    await controller.behaviorOverview(ctx);

    expect(getUmamiBehaviorReportMock).not.toHaveBeenCalled();
  });
});
