const mockStrapi: any = {};
const mockBuildCacheKey = jest.fn((_options: unknown) => "product-cache-key");
const mockWithCache = jest.fn(async (_options: unknown, loader: () => Promise<unknown>) =>
  loader(),
);
const mockIsTrustedWordPressMigrationRequest = jest.fn(() => false);

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: jest.fn((_uid, factory) => factory({ strapi: mockStrapi })),
  },
}));

jest.mock("../../../utils/responseCache", () => ({
  buildCacheKey: (options: unknown) => mockBuildCacheKey(options),
  getCacheTtlFromEnv: jest.fn((_envName: string, fallback: number) => fallback),
  isCacheDebugHeaderEnabled: jest.fn(() => false),
  shouldBypassEndpointCache: jest.fn(() => false),
  withCache: (options: unknown, loader: () => Promise<unknown>) => mockWithCache(options, loader),
}));

jest.mock("../../../utils/migration-context", () => ({
  isTrustedWordPressMigrationRequest: () => mockIsTrustedWordPressMigrationRequest(),
}));

import productController from "../controllers/product";

const makeActiveProduct = () => ({
  id: 12,
  Title: "Shell Product",
  Status: "Active",
  removedAt: null,
});

const makeCtx = (query: Record<string, unknown> = {}) =>
  ({
    params: { slug: "shell-product" },
    query,
    request: { headers: {} },
    state: {},
    set: jest.fn(),
    notFound: jest.fn((message: string) => ({ status: 404, message })),
    badRequest: jest.fn((message: string, payload?: unknown) => ({
      status: 400,
      message,
      payload,
    })),
  }) as any;

describe("product.findBySlug", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTrustedWordPressMigrationRequest.mockReturnValue(false);
    mockStrapi.entityService = {
      findMany: jest.fn().mockResolvedValue([makeActiveProduct()]),
    };
    mockStrapi.db = {
      connection: jest.fn(),
    };
    mockStrapi.log = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockStrapi.service = jest.fn(() => ({
      queueProductView: jest.fn(),
    }));
  });

  it("lets a trusted migration list inactive products while still excluding trash", () => {
    mockIsTrustedWordPressMigrationRequest.mockReturnValue(true);
    const ctx: any = {
      query: { filters: { external_source: { $eq: "woocommerce" } } },
      state: {},
    };

    expect((productController as any).applyPublicProductFilters(ctx)).toBe(true);
    expect(ctx.query.filters.$and).toEqual([
      { external_source: { $eq: "woocommerce" } },
      { removedAt: { $null: true } },
    ]);
  });

  it("keeps the active-only filter for untrusted product lists", () => {
    const ctx: any = { query: { filters: {} }, state: {} };

    expect((productController as any).applyPublicProductFilters(ctx)).toBe(true);
    expect(ctx.query.filters.$and).toEqual([{ removedAt: { $null: true } }, { Status: "Active" }]);
  });

  it("lets Store Managers inspect inactive catalog records", () => {
    const ctx: any = {
      query: { filters: {} },
      state: { user: { role: { name: "Store manager" } } },
    };

    expect((productController as any).applyPublicProductFilters(ctx)).toBe(false);
    expect(ctx.query.filters).toEqual({});
  });

  it("keeps Editors on the public catalog view", () => {
    const ctx: any = {
      query: { filters: {} },
      state: {
        user: { isAdmin: true, role: { name: "Editor" } },
      },
    };

    expect((productController as any).applyPublicProductFilters(ctx)).toBe(true);
    expect(ctx.query.filters.$and).toEqual([{ removedAt: { $null: true } }, { Status: "Active" }]);
  });

  it("keeps the default by-slug response on the full review populate", async () => {
    const ctx = makeCtx();

    const result = await (productController as any).findBySlug(ctx);

    expect(result).toEqual({ data: makeActiveProduct() });
    expect(mockStrapi.entityService.findMany).toHaveBeenCalledWith(
      "api::product.product",
      expect.objectContaining({
        populate: expect.objectContaining({
          product_reviews: expect.objectContaining({
            populate: expect.objectContaining({
              user: expect.any(Object),
            }),
          }),
          product_variations: expect.objectContaining({
            populate: expect.objectContaining({
              product_stock: true,
            }),
          }),
        }),
      }),
    );
    expect(mockBuildCacheKey).toHaveBeenCalledWith(
      expect.objectContaining({
        query: {},
      }),
    );
  });

  it("uses the lean shell populate when view=shell is requested", async () => {
    const ctx = makeCtx({ view: "shell" });

    await (productController as any).findBySlug(ctx);

    const populate = mockStrapi.entityService.findMany.mock.calls[0][1].populate;
    expect(populate.product_reviews).toBeUndefined();
    expect(populate).toEqual(
      expect.objectContaining({
        CoverImage: true,
        Media: true,
        Files: true,
        product_main_category: true,
        product_other_categories: true,
        product_tags: true,
        product_faqs: true,
        product_variations: expect.objectContaining({
          populate: expect.objectContaining({
            product_variation_color: true,
            product_variation_size: true,
            product_variation_model: true,
            product_stock: true,
          }),
        }),
        product_size_helper: expect.objectContaining({
          populate: expect.objectContaining({
            Image: true,
          }),
        }),
      }),
    );
    expect(mockBuildCacheKey).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { view: "shell" },
      }),
    );
  });
});
