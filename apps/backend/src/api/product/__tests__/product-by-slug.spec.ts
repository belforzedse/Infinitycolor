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

  it("looks up every encoding candidate so percent-encoded stored slugs resolve", async () => {
    const persian = "ست-تاپ-و-دامن-فلامنت-y00574";
    const ctx = makeCtx({ view: "shell" });
    ctx.params.slug = persian;

    await (productController as any).findBySlug(ctx);

    const filters = mockStrapi.entityService.findMany.mock.calls[0][1].filters;
    expect(filters.Slug.$in).toEqual(expect.arrayContaining([persian]));
    // WooCommerce stored lowercase percent-encoding; the candidate set must include it.
    expect(filters.Slug.$in.some((c: string) => c.includes("%d8") || c.includes("%D8"))).toBe(
      true,
    );
  });

  it("falls back to ProductSlugAlias when the canonical slug no longer matches", async () => {
    const encoded =
      "%d8%b3%d8%aa-%d8%aa%d8%a7%d9%be-%d9%88-%d8%af%d8%a7%d9%85%d9%86-%d9%81%d9%84%d8%a7%d9%85%d9%86%d8%aa-y00574";
    const product = { ...makeActiveProduct(), id: 2833, Slug: "ست-تاپ-و-دامن-فلامنت-y00574" };
    mockStrapi.entityService.findMany
      .mockResolvedValueOnce([]) // product candidate miss
      .mockResolvedValueOnce([{ id: 9, Slug: encoded, product: { id: 2833 } }]) // alias hit
      .mockResolvedValueOnce([product]); // load by id

    const ctx = makeCtx({ view: "shell" });
    ctx.params.slug = encoded;

    const result = await (productController as any).findBySlug(ctx);

    expect(result).toEqual({ data: product });
    expect(mockStrapi.entityService.findMany).toHaveBeenCalledWith(
      "api::product-slug-alias.product-slug-alias",
      expect.objectContaining({
        filters: expect.objectContaining({
          Slug: expect.objectContaining({ $in: expect.any(Array) }),
        }),
      }),
    );
  });

  it("returns 503 instead of 400 when the lookup throws", async () => {
    mockStrapi.entityService.findMany.mockRejectedValueOnce(new Error("db timeout"));
    const ctx = makeCtx();
    ctx.status = 200;
    ctx.set = jest.fn();
    ctx.body = undefined;

    await (productController as any).findBySlug(ctx);

    expect(ctx.status).toBe(503);
    expect(ctx.body?.error?.status).toBe(503);
    expect(ctx.badRequest).not.toHaveBeenCalled();
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
            selected_attribute_terms: expect.objectContaining({
              populate: expect.objectContaining({
                product_attribute: true,
              }),
            }),
            product_stock: true,
          }),
        }),
        product_attribute_assignments: expect.objectContaining({
          populate: expect.objectContaining({
            product_attribute: true,
            terms: expect.objectContaining({
              populate: expect.objectContaining({
                product_attribute: true,
              }),
            }),
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

  it("queries the lowercase WooCommerce encoding for a decoded Persian slug", async () => {
    const ctx = makeCtx({ view: "shell" });
    ctx.params.slug = "کت-آدلینا-w00238";

    await (productController as any).findBySlug(ctx);

    const filters = mockStrapi.entityService.findMany.mock.calls[0][1].filters;
    expect(filters.Slug.$in).toEqual(
      expect.arrayContaining([
        "کت-آدلینا-w00238",
        "%da%a9%d8%aa-%d8%a2%d8%af%d9%84%db%8c%d9%86%d8%a7-w00238",
      ]),
    );
  });

});
