const mockGetOrderEvents = jest.fn().mockResolvedValue({ data: [] });
const mockGetAdminEvents = jest.fn().mockResolvedValue({ data: [] });
let persistedRoleName = "Customer";
const mockStrapi: any = {
  service: jest.fn(() => ({
    getOrderEvents: mockGetOrderEvents,
    getAdminEvents: mockGetAdminEvents,
  })),
  entityService: { findOne: jest.fn() },
  query: jest.fn((uid: string) => {
    if (uid !== "plugin::users-permissions.user") throw new Error(`Unexpected query: ${uid}`);
    return {
      findOne: jest.fn().mockImplementation(async () => ({
        id: 10,
        role: { name: persistedRoleName },
      })),
    };
  }),
};

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: jest.fn((_uid, factory) => factory({ strapi: mockStrapi })),
  },
}));

import eventLogController from "../controllers/event-log";
import eventLogRoutes from "../routes/custom-router";

function createCtx(roleName: string, overrides: Record<string, unknown> = {}) {
  persistedRoleName = roleName;
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

    expect(ctx.forbidden).toHaveBeenCalledWith(
      "You do not have permission to perform this action",
    );
    expect(mockGetAdminEvents).not.toHaveBeenCalled();
  });

  it("guards the global admin event route with the audit capability", () => {
    const route = eventLogRoutes.routes.find((entry) => entry.path === "/event-logs/admin");

    expect(route?.config?.policies).toEqual([
      {
        name: "global::require-capability",
        config: { capability: "system.audit.read" },
      },
    ]);
  });

  it("retains Superadmin access to order-scoped events", async () => {
    const ctx = createCtx("Superadmin");

    await (eventLogController as any).getOrderEvents(ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
    expect(mockStrapi.entityService.findOne).not.toHaveBeenCalled();
    expect(mockGetOrderEvents).toHaveBeenCalled();
  });
});
