/**
 * Founder role access tests for the report controller.
 *
 * Uses the REAL roles util (ROLE_NAMES / roleIsAllowed) so the assertions exercise the
 * actual allowed-role arrays wired into each handler. The analytics/product services
 * are mocked to avoid heavy imports/side effects.
 *
 * Contract:
 *  - Founder MAY call productSales (sales report under «گزارشات فروش»).
 *  - Founder MAY call traffic through report.traffic.read.
 *  - Founder MUST NOT call standalone admin-activity reports (Superadmin-only).
 */

jest.mock("../../services/umami", () => ({
  UMAMI_DEFINITION_VERSION: "umami-infinity-v1",
  UMAMI_REPORT_TIMEZONE: "Asia/Tehran",
  isUmamiConfigured: jest.fn(() => true),
  normalizeRange: jest.fn(() => ({ startDate: "2026-01-01", endDate: "2026-01-31" })),
  previousRange: jest.fn(() => ({ startDate: "2025-12-01", endDate: "2025-12-31" })),
  normalizeUmamiFilters: jest.fn(() => ({})),
  getUmamiBehaviorReport: jest.fn().mockResolvedValue({
    kind: "overview",
    range: { startDate: "2026-01-01", endDate: "2026-01-31" },
    sections: {},
    errors: {},
  }),
  getUmamiRealtimeReport: jest.fn().mockResolvedValue({ activeVisitors: 0, topPages: [], raw: {} }),
}));

jest.mock("../../services/product-analytics", () => ({}));

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

/** Wire a global strapi whose user lookup returns a user with the given role name. */
function mockStrapiForRole(roleName: string) {
  (global as any).strapi = {
    query: () => ({
      findOne: jest.fn().mockResolvedValue({ id: 1, role: { name: roleName } }),
    }),
    db: {
      connection: {
        raw: jest.fn().mockResolvedValue({ rows: [] }),
      },
    },
  };
}

function mockStrapiForAdminActivitySearch() {
  const entityFindMany = jest
    .fn()
    .mockResolvedValueOnce([{ id: 12 }])
    .mockResolvedValueOnce([{ id: 77 }])
    .mockResolvedValueOnce([{ id: 88 }])
    .mockResolvedValueOnce([]);
  const entityCount = jest.fn().mockResolvedValue(0);

  (global as any).strapi = {
    query: () => ({
      findOne: jest.fn().mockResolvedValue({ id: 1, role: { name: "Superadmin" } }),
    }),
    entityService: {
      findMany: entityFindMany,
      count: entityCount,
    },
    db: {
      connection: Object.assign(jest.fn(), {
        schema: { hasTable: jest.fn().mockResolvedValue(false) },
        raw: jest.fn().mockResolvedValue({ rows: [] }),
      }),
    },
    log: {
      warn: jest.fn(),
    },
  };

  return { entityFindMany, entityCount };
}

describe("report controller - Founder access", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("allows Founder to call productSales (does not forbid)", async () => {
    mockStrapiForRole("Founder");
    const controller = loadController();
    const ctx = createCtx();

    await controller.productSales(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  it("allows Founder to call the behavior overview", async () => {
    mockStrapiForRole("Founder");
    const controller = loadController();
    const ctx = createCtx();

    await controller.behaviorOverview(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  it("allows Founder to call realtime behavior", async () => {
    mockStrapiForRole("Founder");
    const controller = loadController();
    const ctx = createCtx();

    await controller.behaviorRealtime(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  it("blocks Founder from the global admin-activity report", async () => {
    mockStrapiForRole("Founder");
    const controller = loadController();
    const ctx = createCtx();

    await controller.adminActivity(ctx);

    expect(ctx.forbidden).toHaveBeenCalled();
  });

  it("blocks Founder from standalone admin-activity detail", async () => {
    mockStrapiForRole("Founder");
    const controller = loadController();
    const ctx = createCtx({ params: { id: 12 } });

    await controller.adminActivityById(ctx);

    expect(ctx.forbidden).toHaveBeenCalled();
  });

  it("blocks a Customer from productSales", async () => {
    mockStrapiForRole("Customer");
    const controller = loadController();
    const ctx = createCtx();

    await controller.productSales(ctx);

    expect(ctx.forbidden).toHaveBeenCalled();
  });

  it("allows Founder to call salesBreakdown (does not forbid)", async () => {
    mockStrapiForRole("Founder");
    const controller = loadController();
    const ctx = createCtx({ query: { dimension: "status" } });

    await controller.salesBreakdown(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  it("blocks a Customer from salesBreakdown", async () => {
    mockStrapiForRole("Customer");
    const controller = loadController();
    const ctx = createCtx({ query: { dimension: "status" } });

    await controller.salesBreakdown(ctx);

    expect(ctx.forbidden).toHaveBeenCalled();
  });

  it("allows Founder to call overview (does not forbid)", async () => {
    mockStrapiForRole("Founder");
    const controller = loadController();
    const ctx = createCtx();

    await controller.overview(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  it("blocks a Customer from overview", async () => {
    mockStrapiForRole("Customer");
    const controller = loadController();
    const ctx = createCtx();

    await controller.overview(ctx);

    expect(ctx.forbidden).toHaveBeenCalled();
  });

  it("allows Founder to call behaviorConversion (does not forbid)", async () => {
    mockStrapiForRole("Founder");
    const controller = loadController();
    const ctx = createCtx();

    await controller.behaviorConversion(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  it("blocks a Customer from behaviorConversion", async () => {
    mockStrapiForRole("Customer");
    const controller = loadController();
    const ctx = createCtx();

    await controller.behaviorConversion(ctx);

    expect(ctx.forbidden).toHaveBeenCalled();
  });

  it("allows Founder to call salesBreakdownExport (does not forbid)", async () => {
    mockStrapiForRole("Founder");
    const controller = loadController();
    const ctx = createCtx({ query: { dimension: "coupon" } });

    await controller.salesBreakdownExport(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  it("allows Store Manager product insights but blocks finance liquidity", async () => {
    mockStrapiForRole("Store Manager");
    const controller = loadController();
    const productCtx = createCtx();
    const liquidityCtx = createCtx();

    await controller.productSales(productCtx);
    await controller.liquidity(liquidityCtx);

    expect(productCtx.forbidden).not.toHaveBeenCalled();
    expect(liquidityCtx.forbidden).toHaveBeenCalledWith(
      "You do not have permission to perform this action",
    );
  });

  it("filters admin activity by product search and related order ids", async () => {
    const { entityFindMany } = mockStrapiForAdminActivitySearch();
    const controller = loadController();
    const ctx = createCtx({
      query: {
        start: "2026-01-01",
        end: "2026-01-31",
        resourceSearch: "SKU-100",
        resourceScope: "all",
      },
    });

    await controller.adminActivity(ctx);

    expect(entityFindMany).toHaveBeenNthCalledWith(
      1,
      "api::product.product",
      expect.objectContaining({
        filters: expect.objectContaining({
          $or: expect.arrayContaining([{ product_variations: { SKU: { $containsi: "SKU-100" } } }]),
        }),
      }),
    );
    expect(entityFindMany).toHaveBeenNthCalledWith(
      4,
      "api::manual-admin-activity.manual-admin-activity",
      expect.objectContaining({
        filters: expect.objectContaining({
          $and: [
            {
              $or: [
                { ResourceType: "Order", ResourceId: { $in: ["77", "88"] } },
                { ResourceType: "Product", ResourceId: { $in: ["12"] } },
              ],
            },
          ],
        }),
      }),
    );
  });
});
