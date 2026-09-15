const mockStrapi: any = {
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
};
const mockFindMany = jest.fn();
const mockFindOne = jest.fn();
const mockReadDraft = jest.fn();
const mockCreateDraft = jest.fn();

mockStrapi.entityService = {
  findMany: (...args: unknown[]) => mockFindMany(...args),
  findOne: (...args: unknown[]) => mockFindOne(...args),
};

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: jest.fn((_uid, factory) => factory({ strapi: mockStrapi })),
  },
}));

jest.mock("../../../utils/migration-context", () => ({
  isTrustedWordPressMigrationRequest: () => false,
}));

jest.mock("../services/product-publication", () => ({
  executePublicationCommand: jest.fn(),
  runPublicationEffects: jest.fn(),
  PublicationCommandError: class extends Error {},
}));

jest.mock("../../../queue/product-publication-queue", () => ({
  enqueueScheduledProductPublication: jest.fn(),
  removeScheduledProductPublication: jest.fn(),
}));

jest.mock("../../../utils/responseCache", () => ({
  buildCacheKey: jest.fn(() => "key"),
  getCacheTtlFromEnv: jest.fn((_name: string, fallback: number) => fallback),
  isCacheDebugHeaderEnabled: jest.fn(() => false),
  shouldBypassEndpointCache: jest.fn(() => true),
  withCache: jest.fn(async (_options: unknown, loader: () => Promise<unknown>) => loader()),
}));

jest.mock("../services/product-preview-draft", () => ({
  createProductPreviewDraft: (...args: unknown[]) => mockCreateDraft(...args),
  readProductPreviewDraft: (...args: unknown[]) => mockReadDraft(...args),
  sanitizeProductPreviewOverlay: (input: unknown) => input,
}));

import productController from "../controllers/product";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    request: { body: { data: {} }, headers: {}, ip: "127.0.0.1" },
    state: {},
    notFound: jest.fn((message: string) => ({ message })),
    set: jest.fn(),
    ...overrides,
  } as any;
}

/**
 * `entityService.findMany`/`findOne` in Strapi v4 return the pre-serialization
 * shape — flat fields, flat relations — not the `{ data: { attributes } } }`
 * wrapping Strapi's own response pipeline applies on the way out over HTTP.
 * `updateDisplayDate` in the real controller relies on exactly this (reads
 * `existing.LastEditedByAdminAt` with no `.attributes`). Every fixture below
 * mirrors that shape on purpose — a controller that wrote `.attributes` here
 * would silently no-op instead of failing loudly.
 */
const flatSavedProduct = {
  id: 12,
  Title: "Saved title",
  Description: "Saved description",
  Status: "Active",
  removedAt: null,
  CoverImage: { id: 1, url: "/uploads/saved.jpg" },
  product_variations: [
    { id: 99, Price: 1000, DiscountPrice: null, product_stock: { id: 5, Count: 10 } },
  ],
};

describe("product preview-draft controller contract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindMany.mockResolvedValue([flatSavedProduct]);
    mockFindOne.mockImplementation((uid: string, id: number) => {
      if (uid === "plugin::upload.file") return { id, url: `/uploads/draft-${id}.jpg` };
      return null;
    });
  });

  it("merges the draft overlay onto the flat live product, not its saved values", async () => {
    mockReadDraft.mockResolvedValue({
      productId: 12,
      overlay: {
        Title: "Draft title",
        coverImageId: 42,
        simpleVariationId: 99,
        simplePrice: 2000,
        simpleStock: 3,
      },
    });

    const ctx = makeCtx({ params: { token: "abc123" } });
    await (productController as any).resolvePreviewDraft(ctx);

    expect(mockFindMany).toHaveBeenCalledWith(
      "api::product.product",
      expect.objectContaining({ filters: expect.objectContaining({ id: 12 }) }),
    );

    // The regression this guards: a controller writing `attrs.X` against
    // `product.attributes` (undefined on this flat shape) applies nothing and
    // ctx.body silently equals the saved product — exactly what the admin's
    // "must reflect unsaved edits" requirement forbids.
    expect(ctx.body.data.Title).toBe("Draft title");
    expect(ctx.body.data.CoverImage).toEqual({ id: 42, url: "/uploads/draft-42.jpg" });
    expect(ctx.body.data.CoverImage.data).toBeUndefined();

    const variation = ctx.body.data.product_variations[0];
    expect(variation.Price).toBe(2000);
    expect(variation.product_stock.Count).toBe(3);
    // Untouched by the overlay — must survive the merge unchanged.
    expect(variation.DiscountPrice).toBeNull();
    expect(ctx.body.data.Description).toBe("Saved description");
  });

  it("bypasses the Active-only gate for the live product lookup", async () => {
    mockReadDraft.mockResolvedValue({ productId: 12, overlay: {} });

    const ctx = makeCtx({ params: { token: "abc123" } });
    await (productController as any).resolvePreviewDraft(ctx);

    const [, options] = mockFindMany.mock.calls[0];
    expect(options.filters.Status).toBeUndefined();
  });

  it("404s without leaking whether the token is malformed vs. simply expired", async () => {
    mockReadDraft.mockResolvedValue(null);

    const ctx = makeCtx({ params: { token: "expired-or-bogus" } });
    await (productController as any).resolvePreviewDraft(ctx);

    expect(ctx.notFound).toHaveBeenCalled();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("returns an absolute storefront URL, since the admin app is a different origin", async () => {
    const originalFrontendUrl = process.env.FRONTEND_URL;
    const originalFrontendBaseUrl = process.env.FRONTEND_BASE_URL;
    process.env.FRONTEND_BASE_URL = "https://storefront.test.invalid";
    delete process.env.FRONTEND_URL;

    mockCreateDraft.mockResolvedValue("new-token");
    const ctx = makeCtx({
      params: { id: "12" },
      request: { body: { data: { Title: "Draft title" } } },
      state: { user: { id: 7 } },
    });

    try {
      await (productController as any).createPreviewDraft(ctx);
    } finally {
      if (originalFrontendBaseUrl === undefined) delete process.env.FRONTEND_BASE_URL;
      else process.env.FRONTEND_BASE_URL = originalFrontendBaseUrl;
      if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = originalFrontendUrl;
    }

    expect(mockCreateDraft).toHaveBeenCalledWith(12, { Title: "Draft title" }, 7);
    expect(ctx.body).toEqual({
      data: {
        token: "new-token",
        url: "https://storefront.test.invalid/pdp/preview/new-token",
      },
    });
  });
});
