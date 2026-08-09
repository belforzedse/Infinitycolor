/**
 * Founder role access tests for the report controller.
 *
 * Uses the REAL roles util (ROLE_NAMES / roleIsAllowed) so the assertions exercise the
 * actual allowed-role arrays wired into each handler. The matomo/product-analytics services
 * are mocked to avoid heavy imports/side effects.
 *
 * Contract:
 *  - Founder MAY call productSales (sales report under «گزارشات فروش»).
 *  - Founder MAY call traffic through report.traffic.read.
 *  - Founder MUST NOT call standalone admin-activity reports (Superadmin-only).
 */

jest.mock("../../services/matomo", () => ({
  normalizeRange: jest.fn(() => ({ startDate: "2026-01-01", endDate: "2026-01-31" })),
  getMatomoRealtimePayload: jest.fn(),
  getMatomoTrafficDashboardPayload: jest.fn(),
  getProductBehavioral: jest.fn(),
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

  it("allows Founder to call the traffic dashboard", async () => {
    mockStrapiForRole("Founder");
    const controller = loadController();
    const ctx = createCtx();

    await controller.trafficDashboard(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  it("allows Founder to call realtime traffic", async () => {
    mockStrapiForRole("Founder");
    const controller = loadController();
    const ctx = createCtx();

    await controller.trafficRealtime(ctx);

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

  it("allows Founder to call funnel (does not forbid)", async () => {
    mockStrapiForRole("Founder");
    const controller = loadController();
    const ctx = createCtx();

    await controller.funnel(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  it("blocks a Customer from funnel", async () => {
    mockStrapiForRole("Customer");
    const controller = loadController();
    const ctx = createCtx();

    await controller.funnel(ctx);

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
