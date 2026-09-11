let mockStrapi: any;
jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, factory: any) => factory({ strapi: mockStrapi }),
  },
}));
jest.mock("@repo/auth-core", () => ({ hasCapability: jest.fn(() => false) }));
jest.mock("../../../utils/roles", () => ({
  fetchUserWithRole: jest.fn(),
  resolveCustomerTargetUserId: jest.fn(),
}));
jest.mock("../../../utils/adminAuthorization", () => ({
  requireCapability: jest.fn(),
  resolveAdminActor: jest.fn(async () => null),
}));
jest.mock("../../../utils/blog-helpers", () => ({ resolveUserDisplayName: jest.fn() }));
jest.mock("../../../utils/normalizePopulate", () => ({
  normalizePopulateQuery: jest.fn((value: unknown) => value),
}));
jest.mock("../../../utils/responseCache", () => ({
  buildCacheKey: jest.fn(() => "key"),
  getCacheTtlFromEnv: jest.fn(() => 60),
  isCacheDebugHeaderEnabled: jest.fn(() => false),
  shouldBypassEndpointCache: jest.fn(() => true),
  withCache: jest.fn(async (_opts: unknown, loader: () => unknown) => loader()),
}));

// A commenter's live display name (blogCommentAuthorName.ts) only resolves
// from a populated `user.user_info` relation; without it every comment falls
// back to whatever name was snapshotted at creation time, which goes stale
// the moment a customer completes their profile after commenting.
describe("blog-comment findByPost", () => {
  let controller: any;

  beforeEach(() => {
    jest.resetModules();
    mockStrapi = {
      entityService: { findMany: jest.fn(async () => []) },
    };
    controller = require("../controllers/blog-comment").default;
  });

  it("populates the commenter's user_info relation, not just the bare user", async () => {
    const ctx = { params: { postId: "5" }, request: { headers: {} }, state: {}, query: {} };

    await controller.findByPost(ctx);

    expect(mockStrapi.entityService.findMany).toHaveBeenCalledWith(
      "api::blog-comment.blog-comment",
      expect.objectContaining({
        populate: expect.objectContaining({
          user: expect.objectContaining({ populate: expect.arrayContaining(["user_info"]) }),
        }),
      }),
    );
  });
});
