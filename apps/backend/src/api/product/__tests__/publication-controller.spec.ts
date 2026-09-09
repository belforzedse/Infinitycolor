const mockStrapi: any = {
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
};
const mockTrusted = jest.fn(() => false);
const mockExecute = jest.fn();
const mockEffects = jest.fn();
const mockEnqueue = jest.fn();
const mockRemove = jest.fn();
const mockCoreCreate = jest.fn();
const mockUpdateProduct = jest.fn();
let mockAdminUser: any;

mockStrapi.query = jest.fn((uid: string) => {
  if (uid !== "plugin::users-permissions.user") throw new Error(`Unexpected query: ${uid}`);
  return { findOne: jest.fn().mockImplementation(async () => mockAdminUser) };
});
mockStrapi.entityService = { update: (...args: unknown[]) => mockUpdateProduct(...args) };

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: jest.fn((_uid, factory) => factory({ strapi: mockStrapi })),
  },
}));

jest.mock("../../../utils/migration-context", () => ({
  isTrustedWordPressMigrationRequest: () => mockTrusted(),
}));

jest.mock("../services/product-publication", () => {
  class PublicationCommandError extends Error {
    code: string;
    status: number;
    permanent: boolean;
    constructor(code: string, status = 400, permanent = true) {
      super(code);
      this.code = code;
      this.status = status;
      this.permanent = permanent;
    }
  }
  return {
    executePublicationCommand: (...args: unknown[]) => mockExecute(...args),
    runPublicationEffects: (...args: unknown[]) => mockEffects(...args),
    PublicationCommandError,
  };
});

jest.mock("../../../queue/product-publication-queue", () => ({
  enqueueScheduledProductPublication: (...args: unknown[]) => mockEnqueue(...args),
  removeScheduledProductPublication: (...args: unknown[]) => mockRemove(...args),
}));

jest.mock("../../../utils/responseCache", () => ({
  buildCacheKey: jest.fn(() => "key"),
  getCacheTtlFromEnv: jest.fn((_name: string, fallback: number) => fallback),
  isCacheDebugHeaderEnabled: jest.fn(() => false),
  shouldBypassEndpointCache: jest.fn(() => true),
  withCache: jest.fn(async (_options: unknown, loader: () => Promise<unknown>) => loader()),
}));

import productController from "../controllers/product";

Object.setPrototypeOf(productController as object, {
  create: mockCoreCreate,
});

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    params: { id: "12" },
    request: { body: { data: {} }, headers: {}, ip: "127.0.0.1" },
    state: {},
    forbidden: jest.fn((message: string, details: unknown) => ({ message, details })),
    ...overrides,
  } as any;
}

describe("product publication controller contract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminUser = {
      id: 7,
      username: "manager",
      IsActive: true,
      blocked: false,
      role: { name: "Store Manager" },
    };
    mockTrusted.mockReturnValue(false);
    mockExecute.mockResolvedValue({
      productId: 12,
      status: "Active",
      scheduledPublishAt: null,
      scheduledPublishTimezone: null,
      scheduleRevision: 2,
      publicationRevision: 4,
      previousScheduleRevision: 1,
      changed: true,
      needsPublicationEffects: true,
    });
    mockEffects.mockResolvedValue({ completed: true, revision: 4 });
    mockEnqueue.mockResolvedValue("job-id");
    mockRemove.mockResolvedValue(true);
    mockCoreCreate.mockResolvedValue({ data: { id: 12 } });
    mockUpdateProduct.mockResolvedValue({ id: 12 });
  });

  it("accepts the legacy default draft status during product creation", async () => {
    const ctx = makeCtx({
      request: { body: { data: { Title: "Legacy admin draft", Status: "InActive" } } },
    });

    await (productController as any).create(ctx);

    expect(mockCoreCreate).toHaveBeenCalledWith(ctx);
    expect(ctx.status).toBeUndefined();
    expect(ctx.request.body.data).toEqual({
      Title: "Legacy admin draft",
      Status: "InActive",
    });
  });

  it("still rejects attempts to publish through generic product creation", async () => {
    const ctx = makeCtx({
      request: { body: { data: { Title: "Invalid published product", Status: "Active" } } },
    });

    await (productController as any).create(ctx);

    expect(ctx.status).toBe(400);
    expect(ctx.body.error.details).toEqual({
      code: "PUBLICATION_COMMAND_REQUIRED",
      fields: ["Status"],
    });
    expect(mockCoreCreate).not.toHaveBeenCalled();
  });

  it("rejects publication fields through generic update", async () => {
    const ctx = makeCtx({
      request: { body: { data: { Status: "Active", scheduledPublishAt: null } } },
    });

    await (productController as any).update(ctx);

    expect(ctx.status).toBe(400);
    expect(ctx.body.error.details).toEqual({
      code: "PUBLICATION_COMMAND_REQUIRED",
      fields: ["Status", "scheduledPublishAt"],
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("rejects an Editor even when it carries a legacy isAdmin flag", async () => {
    mockAdminUser = {
      id: 5,
      username: "editor",
      IsActive: true,
      blocked: false,
      role: { name: "Editor" },
    };
    const ctx = makeCtx({
      request: { body: { data: { action: "publish-now" } }, headers: {} },
      state: { user: { id: 5, isAdmin: true, role: { name: "Editor" } } },
    });

    await (productController as any).publication(ctx);

    expect(ctx.forbidden).toHaveBeenCalledWith(
      "Publication action is not allowed",
      { code: "PUBLICATION_FORBIDDEN" },
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("lets a Store Manager inherit immediate publishing from Seller 1", async () => {
    const ctx = makeCtx({
      request: { body: { data: { action: "publish-now" } }, headers: {} },
      state: {
        user: {
          id: 7,
          username: "manager",
          role: { name: "Store Manager" },
        },
      },
    });

    await (productController as any).publication(ctx);

    expect(mockExecute).toHaveBeenCalledWith(
      mockStrapi,
      12,
      expect.objectContaining({ action: "publish-now", requireMedia: false }),
      expect.objectContaining({ origin: "admin", actor: expect.objectContaining({ id: 7 }) }),
    );
    expect(mockEffects).toHaveBeenCalledWith(mockStrapi, 12, 4);
    expect(ctx.body.data).toEqual(expect.objectContaining({
      Status: "Active",
      queueState: "not-required",
    }));
  });

  it("lets a Store Manager schedule publication", async () => {
    const ctx = makeCtx({
      request: {
        body: {
          data: {
            action: "schedule",
            publishAt: "2026-08-09T12:00:00.000Z",
            timezone: "Asia/Tehran",
          },
        },
        headers: {},
      },
      state: { user: { id: 7, role: { name: "Store Manager" } } },
    });

    await (productController as any).publication(ctx);

    expect(mockExecute).toHaveBeenCalledWith(
      mockStrapi,
      12,
      expect.objectContaining({
        action: "schedule",
        publishAt: "2026-08-09T12:00:00.000Z",
        timezone: "Asia/Tehran",
      }),
      expect.objectContaining({ origin: "admin" }),
    );
  });

  it("updates only the product display date through the scoped action", async () => {
    const ctx = makeCtx({
      request: {
        body: { data: { displayAt: "2026-08-09T07:07:00.000Z" } },
        headers: {},
      },
      state: { user: { id: 5, role: { name: "Editor" } } },
    });

    await (productController as any).updateDisplayDate(ctx);

    expect(mockUpdateProduct).toHaveBeenCalledWith("api::product.product", 12, {
      data: { LastEditedByAdminAt: "2026-08-09T07:07:00.000Z" },
    });
    expect(ctx.body).toEqual({
      data: { id: 12, LastEditedByAdminAt: "2026-08-09T07:07:00.000Z" },
    });
  });

  it("rejects an invalid product display date", async () => {
    const ctx = makeCtx({
      request: { body: { data: { displayAt: "not-a-date" } }, headers: {} },
    });

    await (productController as any).updateDisplayDate(ctx);

    expect(ctx.status).toBe(400);
    expect(ctx.body.error.code).toBe("INVALID_PRODUCT_DISPLAY_DATE");
    expect(mockUpdateProduct).not.toHaveBeenCalled();
  });

  it("fails closed when a trusted importer omits the matching Woo identity", async () => {
    mockTrusted.mockReturnValue(true);
    const ctx = makeCtx({
      request: { body: { data: { action: "publish-now" } }, headers: {} },
    });

    await (productController as any).publication(ctx);

    expect(ctx.status).toBe(400);
    expect(ctx.body.error.code).toBe("EXTERNAL_PRODUCT_IDENTITY_REQUIRED");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("reports pending reconciliation when delayed enqueue is unavailable", async () => {
    mockAdminUser = {
      id: 1,
      username: "superadmin",
      IsActive: true,
      blocked: false,
      role: { name: "Superadmin" },
    };
    mockExecute.mockResolvedValue({
      productId: 12,
      status: "Scheduled",
      scheduledPublishAt: "2026-08-09T12:00:00.000Z",
      scheduledPublishTimezone: "Asia/Tehran",
      scheduleRevision: 3,
      publicationRevision: 4,
      previousScheduleRevision: 2,
      changed: true,
      needsPublicationEffects: false,
    });
    mockEnqueue.mockRejectedValue(new Error("redis unavailable"));
    const ctx = makeCtx({
      request: {
        body: {
          data: {
            action: "schedule",
            publishAt: "2026-08-09T12:00:00.000Z",
            timezone: "Asia/Tehran",
          },
        },
        headers: {},
      },
      state: { user: { id: 1, role: { name: "Superadmin" } } },
    });

    await (productController as any).publication(ctx);

    expect(ctx.body.data.queueState).toBe("pending-reconciliation");
    expect(mockRemove).toHaveBeenCalledWith(12, 2);
  });
});
