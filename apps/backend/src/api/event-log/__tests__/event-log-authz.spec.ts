const mockGetOrderEvents = jest.fn().mockResolvedValue({ data: [] });
const mockGetAdminEvents = jest.fn().mockResolvedValue({ data: [] });
const mockStrapi: any = {
  service: jest.fn(() => ({
    getOrderEvents: mockGetOrderEvents,
    getAdminEvents: mockGetAdminEvents,
  })),
  entityService: { findOne: jest.fn() },
};

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: jest.fn((_uid, factory) => factory({ strapi: mockStrapi })),
  },
}));

import eventLogController from "../controllers/event-log";
import eventLogRoutes from "../routes/custom-router";

function createCtx(roleName: string, overrides: Record<string, unknown> = {}) {
  return {
    state: { user: { id: 10, isAdmin: true, role: { name: roleName } } },
    params: { orderId: "42" },
    query: {},
    send: jest.fn(),
    forbidden: jest.fn(),
    unauthorized: jest.fn(),
    ...overrides,
  } as any;
}

describe("event log authorization", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not treat Store Manager's generic isAdmin UI flag as audit access", async () => {
    const ctx = createCtx("Store manager");

    await (eventLogController as any).getAdminEvents(ctx);

    expect(ctx.forbidden).toHaveBeenCalledWith("Admin access required");
    expect(mockGetAdminEvents).not.toHaveBeenCalled();
  });

  it("guards the global admin event route with a Superadmin policy", () => {
    const route = eventLogRoutes.routes.find((entry) => entry.path === "/event-logs/admin");

    expect(route?.config?.policies).toEqual([
      {
        name: "global::role-based",
        config: { roles: ["Superadmin"] },
      },
    ]);
  });

  it("retains Founder access to order-scoped events", async () => {
    const ctx = createCtx("Founder");

    await (eventLogController as any).getOrderEvents(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
    expect(mockStrapi.entityService.findOne).not.toHaveBeenCalled();
    expect(mockGetOrderEvents).toHaveBeenCalled();
  });
});
