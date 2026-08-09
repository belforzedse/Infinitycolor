import productLifecycles from "../lifecycles";

describe("product lifecycles - PDP cache invalidation", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REVALIDATION_SECRET: "test-secret",
      NEXTJS_REVALIDATION_URL: "https://new.infinitycolor.co",
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ revalidated: true }),
      text: jest.fn().mockResolvedValue(""),
    } as any);
    (global as any).strapi.entityService.create = jest.fn().mockResolvedValue({ id: 1 });
    (global as any).strapi.entityService.findOne = jest.fn().mockResolvedValue(null);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  const revalidatedSlugs = () =>
    (global.fetch as jest.Mock).mock.calls
      .map(([, init]) => JSON.parse((init as RequestInit).body as string))
      .filter((body) => body.type === "product")
      .map((body) => body.path);

  describe("afterUpdate", () => {
    it("still revalidates the slug when a product becomes Active (existing behavior)", async () => {
      (global as any).strapi.entityService.findOne = jest.fn().mockResolvedValue({
        Title: "My product",
        Slug: "my-product",
        Status: "Active",
      });

      await productLifecycles.afterUpdate({
        params: { data: { Status: "Active" } },
        result: { id: 1, Slug: "my-product", Status: "Active" },
        state: {
          previousProduct: { Title: "My product", Slug: "my-product", Status: "InActive" },
        },
      } as any);

      expect(revalidatedSlugs()).toEqual(["my-product"]);
    });

    it("revalidates the product's own PDP on unpublish (previously a gap)", async () => {
      (global as any).strapi.entityService.findOne = jest.fn().mockResolvedValue({
        Title: "My product",
        Slug: "my-product",
        Status: "InActive",
      });

      await productLifecycles.afterUpdate({
        params: { data: { Status: "InActive" } },
        result: { id: 1, Slug: "my-product", Status: "InActive" },
        state: {
          previousProduct: { Title: "My product", Slug: "my-product", Status: "Active" },
        },
      } as any);

      expect(revalidatedSlugs()).toEqual(["my-product"]);
    });

    it("revalidates both the old and new slug on a rename while still Active", async () => {
      (global as any).strapi.entityService.findOne = jest.fn().mockResolvedValue({
        Title: "My product",
        Slug: "my-new-slug",
        Status: "Active",
      });

      await productLifecycles.afterUpdate({
        params: { data: { Slug: "my-new-slug" } },
        result: { id: 1, Slug: "my-new-slug", Status: "Active" },
        state: {
          previousProduct: { Title: "My product", Slug: "my-old-slug", Status: "Active" },
        },
      } as any);

      const slugs = revalidatedSlugs();
      expect(slugs).toContain("my-new-slug");
      expect(slugs).toContain("my-old-slug");
      expect(slugs).toHaveLength(2);
    });

    it("revalidates the pre-delete slug on soft-delete (removedAt set)", async () => {
      (global as any).strapi.entityService.findOne = jest.fn().mockResolvedValue({
        Title: "My product",
        Slug: "my-product",
        Status: "Active",
        removedAt: "2026-08-08T00:00:00.000Z",
      });

      await productLifecycles.afterUpdate({
        params: { data: { removedAt: "2026-08-08T00:00:00.000Z" } },
        result: { id: 1, Slug: "my-product", Status: "Active" },
        state: {
          previousProduct: {
            Title: "My product",
            Slug: "my-product",
            Status: "Active",
            removedAt: null,
          },
        },
      } as any);

      // Soft-delete still leaves Status Active in this fixture, so the "stays Active"
      // branch and the "removedAt just became truthy" branch both point at the same
      // slug — the Set-based dedupe means it fires exactly once, not twice.
      expect(revalidatedSlugs()).toEqual(["my-product"]);
    });

    it("does not revalidate anything for a genuinely no-op update", async () => {
      (global as any).strapi.entityService.findOne = jest.fn().mockResolvedValue({
        Title: "My product",
        Slug: "my-product",
        Status: "InActive",
      });

      await productLifecycles.afterUpdate({
        params: { data: { Description: "same as before" } },
        result: { id: 1, Slug: "my-product", Status: "InActive" },
        state: {
          previousProduct: { Title: "My product", Slug: "my-product", Status: "InActive" },
        },
      } as any);

      expect(revalidatedSlugs()).toEqual([]);
    });

    it("still skips entirely for counter-only updates (existing behavior preserved)", async () => {
      await productLifecycles.afterUpdate({
        params: { data: { SeenCount: 42 } },
        result: { id: 1, Slug: "my-product", Status: "Active" },
        state: { counterOnlyUpdate: true, previousProduct: {} },
      } as any);

      expect(global.fetch).not.toHaveBeenCalled();
      expect((global as any).strapi.entityService.findOne).not.toHaveBeenCalled();
    });
  });

  describe("beforeDelete + afterDelete", () => {
    it("captures the slug before delete and revalidates it after delete (previously never invalidated)", async () => {
      (global as any).strapi.entityService.findOne = jest.fn().mockResolvedValue({
        Slug: "deleted-product",
      });

      const event: any = { params: { where: { id: 7 } } };
      await productLifecycles.beforeDelete(event);
      expect(event.state.deletingProductSlug).toBe("deleted-product");

      await productLifecycles.afterDelete(event);

      expect(revalidatedSlugs()).toEqual(["deleted-product"]);
    });

    it("does not attempt revalidation if the product had no slug", async () => {
      (global as any).strapi.entityService.findOne = jest.fn().mockResolvedValue({ Slug: null });

      const event: any = { params: { where: { id: 7 } } };
      await productLifecycles.beforeDelete(event);
      await productLifecycles.afterDelete(event);

      expect(revalidatedSlugs()).toEqual([]);
    });
  });
});
