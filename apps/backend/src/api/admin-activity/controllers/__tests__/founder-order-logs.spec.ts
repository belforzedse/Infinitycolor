/**
 * Capability access to order-specific event logs.
 *
 * `findOrderActivities` powers the event-logs panel inside the order detail UI.
 * The capability matrix deliberately reserves audit-log access for Superadmin.
 * Uses the real authorization helper so persisted role checks stay covered.
 */

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, factory: any) =>
      factory({ strapi: (global as any).strapi }),
  },
}));

function loadController() {
  let controller: any;
  jest.isolateModules(() => {
    controller = require("../admin-activity").default;
  });
  return controller;
}

function createCtx(overrides: Partial<any> = {}) {
  return {
    state: { user: { id: 1 } },
    params: { orderId: 42 },
    query: {},
    send: jest.fn(),
    unauthorized: jest.fn(),
    forbidden: jest.fn(),
    ...overrides,
  };
}

function mockStrapiForRole(roleName: string | null) {
  (global as any).strapi = {
    query: () => ({
      findOne: jest.fn().mockResolvedValue(roleName ? { id: 1, role: { name: roleName } } : null),
    }),
    entityService: {
      findMany: jest.fn().mockResolvedValue([{ id: 1, ResourceType: "Order", ResourceId: "42" }]),
      count: jest.fn().mockResolvedValue(1),
    },
  };
}

describe("admin-activity audit capability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("forbids a Founder without order-audit capability", async () => {
    mockStrapiForRole("Founder");
    const controller = loadController();
    const ctx = createCtx();

    await controller.findOrderActivities(ctx);

    expect(ctx.forbidden).toHaveBeenCalledWith(
      "You do not have permission to perform this action",
    );
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it("returns order event logs for a Superadmin (regression)", async () => {
    mockStrapiForRole("Superadmin");
    const controller = loadController();
    const ctx = createCtx();

    await controller.findOrderActivities(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalled();
  });

  it("forbids a Store manager from order event logs", async () => {
    mockStrapiForRole("Store manager");
    const controller = loadController();
    const ctx = createCtx();

    await controller.findOrderActivities(ctx);

    expect(ctx.forbidden).toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it("forbids Store managers from the personal audit endpoint", async () => {
    mockStrapiForRole("Store manager");
    const controller = loadController();
    const ctx = createCtx();

    await controller.findMyActivities(ctx);

    expect(ctx.forbidden).toHaveBeenCalledWith(
      "You do not have permission to perform this action",
    );
    expect(ctx.send).not.toHaveBeenCalled();
  });
});
