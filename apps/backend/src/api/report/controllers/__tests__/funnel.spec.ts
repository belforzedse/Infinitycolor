const fetchUserWithRoleMock = jest.fn();
const roleIsAllowedMock = jest.fn();
const getMatomoFunnelMock = jest.fn();

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
  getMatomoFunnel: (...args: any[]) => getMatomoFunnelMock(...args),
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

describe("report.funnel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).strapi = { db: { connection: { raw: jest.fn() } } };
    fetchUserWithRoleMock.mockResolvedValue({ role: { name: "Founder" } });
    roleIsAllowedMock.mockReturnValue(true);
  });

  it("passes through the funnel steps and marks configured=true when Matomo answered", async () => {
    getMatomoFunnelMock.mockResolvedValue([
      { step: "view_item", count: 100, conversionFromPrevious: null },
      { step: "add_to_cart", count: 40, conversionFromPrevious: 40 },
      { step: "begin_checkout", count: 15, conversionFromPrevious: 37.5 },
      { step: "purchase", count: 5, conversionFromPrevious: 33.33 },
    ]);
    const controller = loadController();
    const ctx = createCtx({ query: { start: "2026-01-01", end: "2026-01-31" } });

    await controller.funnel(ctx);

    expect(ctx.body.data.configured).toBe(true);
    expect(ctx.body.data.steps).toHaveLength(4);
    expect(ctx.body.data.steps[3]).toEqual({ step: "purchase", count: 5, conversionFromPrevious: 33.33 });
    expect(ctx.body.data.range).toEqual({ start: "2026-01-01", end: "2026-01-31" });
    expect(typeof ctx.body.data.note).toBe("string");
  });

  it("returns configured=false and an EMPTY steps array (not zero-filled) when Matomo is unavailable", async () => {
    getMatomoFunnelMock.mockResolvedValue(null);
    const controller = loadController();
    const ctx = createCtx();

    await controller.funnel(ctx);

    expect(ctx.body.data.configured).toBe(false);
    expect(ctx.body.data.steps).toEqual([]);
  });

  it("blocks a Customer", async () => {
    fetchUserWithRoleMock.mockResolvedValue({ role: { name: "Customer" } });
    roleIsAllowedMock.mockReturnValue(false);
    const controller = loadController();
    const ctx = createCtx();

    await controller.funnel(ctx);

    expect(ctx.forbidden).toHaveBeenCalled();
    expect(getMatomoFunnelMock).not.toHaveBeenCalled();
  });
});
