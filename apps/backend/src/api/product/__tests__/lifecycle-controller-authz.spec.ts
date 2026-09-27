/**
 * Server-side authorization of the product lifecycle routes. The route
 * policies are covered by route-auth.spec.ts and the U&P grants by
 * role-permissions.spec.ts; this covers what only the controller decides —
 * which capability each action needs (one bulk route, many actions), that a
 * refusal never reaches the service, and that Undo cannot republish without
 * the publish capability.
 */
import { capabilitiesForRole, hasCapability, normalizeAdminRole } from "@repo/auth-core";

const mockStrapi: any = { log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
const mockTrusted = jest.fn(() => false);
const mockRequireCapability = jest.fn();
const mockBulk = jest.fn();
const mockTrash = jest.fn();
const mockRestore = jest.fn();
const mockPurge = jest.fn();
const mockEmptyTrash = jest.fn();
const mockCoreDelete = jest.fn();

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: jest.fn((_uid, factory) => factory({ strapi: mockStrapi })),
  },
}));
jest.mock("../../../utils/migration-context", () => ({
  isTrustedWordPressMigrationRequest: () => mockTrusted(),
}));
jest.mock("../../../utils/adminAuthorization", () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
  resolveAdminActor: jest.fn(),
}));
jest.mock("../services/product-lifecycle", () => {
  const actual = jest.requireActual("../services/product-lifecycle");
  return {
    BULK_ACTION_CAPABILITY: actual.BULK_ACTION_CAPABILITY,
    parseBulkProductIds: actual.parseBulkProductIds,
    runLifecycleBulk: (...args: unknown[]) => mockBulk(...args),
    trashProduct: (...args: unknown[]) => mockTrash(...args),
    restoreProduct: (...args: unknown[]) => mockRestore(...args),
    purgeProduct: (...args: unknown[]) => mockPurge(...args),
    emptyTrash: (...args: unknown[]) => mockEmptyTrash(...args),
  };
});
jest.mock("../../../queue/product-publication-queue", () => ({
  enqueueScheduledProductPublication: jest.fn(),
  removeScheduledProductPublication: jest.fn(),
}));
jest.mock("../../../utils/adminAudit", () => ({ recordAdminAudit: jest.fn() }));

import productController from "../controllers/product";

Object.setPrototypeOf(productController as object, { delete: mockCoreDelete });

/** requireCapability with the real role → capability map, as the policy applies it. */
function authorizeAs(roleName: string) {
  mockRequireCapability.mockImplementation(async (ctx: any, _strapi: unknown, capability: string) => {
    const role = normalizeAdminRole(roleName);
    if (!role || !hasCapability(role, capability as any)) {
      ctx.status = 403;
      ctx.body = { error: { status: 403, message: "You do not have permission to perform this action" } };
      return null;
    }
    return {
      user: { id: 7, username: "staff", role: { name: roleName, type: roleName } },
      role,
      capabilities: capabilitiesForRole(role),
    };
  });
}

function makeCtx(body: Record<string, unknown> = {}, id = "12") {
  return {
    params: { id },
    request: { body: { data: body }, headers: {}, ip: "127.0.0.1" },
    state: { user: { id: 7 } },
    set: jest.fn(),
    forbidden: jest.fn(),
  } as any;
}

const RESULT = { productId: 12, changed: true, state: "draft", status: "InActive", removedAt: null };

describe("product lifecycle controller authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTrusted.mockReturnValue(false);
    mockBulk.mockResolvedValue({ action: "trash", succeeded: [1], unchanged: [], failed: [], warnings: [] });
    mockTrash.mockResolvedValue({ ...RESULT, state: "trashed" });
    mockRestore.mockResolvedValue(RESULT);
    mockPurge.mockResolvedValue({ ...RESULT, state: "purged" });
    mockEmptyTrash.mockResolvedValue({ purged: 1, failed: 0, remaining: 0 });
  });

  it.each([
    ["publish", "product.publish"],
    ["unpublish", "product.publish"],
    ["schedule", "product.schedule"],
    ["trash", "product.softDelete"],
    ["restore", "product.restore"],
    ["purge", "product.delete"],
  ])("checks the bulk %s action against %s", async (action, capability) => {
    authorizeAs("Superadmin");
    const ctx = makeCtx({
      action,
      ids: [1, 2],
      ...(action === "schedule" ? { publishAt: new Date(Date.now() + 3_600_000).toISOString() } : {}),
    });

    await (productController as any).bulkLifecycle(ctx);

    expect(mockRequireCapability).toHaveBeenCalledWith(ctx, mockStrapi, capability);
    expect(mockBulk).toHaveBeenCalledWith(mockStrapi, action, [1, 2], expect.anything(), expect.anything());
  });

  it("refuses a Seller 1 bulk permanent delete before touching any product", async () => {
    authorizeAs("Seller 1");
    const ctx = makeCtx({ action: "purge", ids: [1] });

    await (productController as any).bulkLifecycle(ctx);

    expect(ctx.status).toBe(403);
    expect(mockBulk).not.toHaveBeenCalled();
  });

  it("refuses a Seller 1 bulk schedule (Seller 2 and up may schedule)", async () => {
    authorizeAs("Seller 1");
    const ctx = makeCtx({
      action: "schedule",
      ids: [1],
      publishAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    await (productController as any).bulkLifecycle(ctx);

    expect(ctx.status).toBe(403);
    expect(mockBulk).not.toHaveBeenCalled();
  });

  it("lets Seller 1 move a selection to Trash", async () => {
    authorizeAs("Seller 1");
    const ctx = makeCtx({ action: "trash", ids: [1, 2] });

    await (productController as any).bulkLifecycle(ctx);

    expect(mockBulk).toHaveBeenCalledWith(
      mockStrapi,
      "trash",
      [1, 2],
      expect.objectContaining({ origin: "admin", actor: expect.objectContaining({ id: 7 }) }),
      expect.anything(),
    );
  });

  it("rejects an unknown bulk action without authorizing anything", async () => {
    authorizeAs("Superadmin");
    const ctx = makeCtx({ action: "archive", ids: [1] });

    await (productController as any).bulkLifecycle(ctx);

    expect(ctx.status).toBe(400);
    expect(mockRequireCapability).not.toHaveBeenCalled();
    expect(mockBulk).not.toHaveBeenCalled();
  });

  it("keeps the core DELETE Superadmin-only and never a row delete for staff", async () => {
    authorizeAs("Store Manager");
    const denied = makeCtx();
    await (productController as any).delete(denied);
    expect(mockRequireCapability).toHaveBeenCalledWith(denied, mockStrapi, "product.delete");
    expect(denied.status).toBe(403);
    expect(mockPurge).not.toHaveBeenCalled();
    expect(mockCoreDelete).not.toHaveBeenCalled();

    authorizeAs("Superadmin");
    const allowed = makeCtx();
    await (productController as any).delete(allowed);
    expect(mockPurge).toHaveBeenCalledWith(mockStrapi, 12, expect.objectContaining({ origin: "admin" }));
    expect(mockCoreDelete).not.toHaveBeenCalled();
  });

  it("keeps the legacy row delete for trusted migration requests only", async () => {
    mockTrusted.mockReturnValue(true);
    const ctx = makeCtx();
    await (productController as any).delete(ctx);
    expect(mockCoreDelete).toHaveBeenCalledWith(ctx);
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it.each([
    ["softDelete", "product.softDelete"],
    ["restore", "product.restore"],
    ["permanentDelete", "product.delete"],
    ["emptyTrash", "product.delete"],
  ])("re-checks %s against %s in the controller", async (handler, capability) => {
    authorizeAs("Editor");
    const ctx = makeCtx({ trashedBefore: new Date().toISOString() });

    await (productController as any)[handler](ctx);

    expect(mockRequireCapability).toHaveBeenCalledWith(ctx, mockStrapi, capability);
    expect(ctx.status).toBe(403);
    expect(mockTrash).not.toHaveBeenCalled();
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockPurge).not.toHaveBeenCalled();
    expect(mockEmptyTrash).not.toHaveBeenCalled();
  });

  it("passes Undo the publish and schedule rights the role actually holds", async () => {
    authorizeAs("Seller 1");
    await (productController as any).restore(makeCtx({ undoToken: "2026-09-27T08:00:00.000Z" }));
    expect(mockRestore).toHaveBeenCalledWith(
      mockStrapi,
      12,
      expect.anything(),
      { undoToken: "2026-09-27T08:00:00.000Z", canPublish: true, canSchedule: false },
    );

    authorizeAs("Store Manager");
    await (productController as any).restore(makeCtx({ undoToken: "2026-09-27T08:00:00.000Z" }));
    expect(mockRestore).toHaveBeenLastCalledWith(
      mockStrapi,
      12,
      expect.anything(),
      { undoToken: "2026-09-27T08:00:00.000Z", canPublish: true, canSchedule: true },
    );
  });

  it("never records a service token's id as the person who trashed a product", async () => {
    mockRequireCapability.mockResolvedValue({
      user: { id: 55, username: "integration", role: { name: "Service", type: "service" } },
      role: "superadmin",
      capabilities: ["product.softDelete"],
    });

    await (productController as any).softDelete(makeCtx());

    expect(mockTrash).toHaveBeenCalledWith(
      mockStrapi,
      12,
      expect.objectContaining({ actor: expect.objectContaining({ id: 0, label: "integration" }) }),
    );
  });
});
