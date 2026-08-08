import { ensureProductSlugAlias } from "../productSlugAlias";

describe("ensureProductSlugAlias", () => {
  const strapi: any = {
    entityService: {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates a new alias when none exists", async () => {
    strapi.entityService.findMany.mockResolvedValueOnce([]);
    await ensureProductSlugAlias(strapi, "%d8%b3-y00574", 2833);
    expect(strapi.entityService.create).toHaveBeenCalledWith(
      "api::product-slug-alias.product-slug-alias",
      { data: { Slug: "%d8%b3-y00574", product: 2833 } },
    );
  });

  it("is a no-op when the alias already points at the same product", async () => {
    strapi.entityService.findMany.mockResolvedValueOnce([
      { id: 1, Slug: "%d8%b3-y00574", product: { id: 2833 } },
    ]);
    await ensureProductSlugAlias(strapi, "%d8%b3-y00574", 2833);
    expect(strapi.entityService.create).not.toHaveBeenCalled();
    expect(strapi.entityService.update).not.toHaveBeenCalled();
  });

  it("re-points an existing alias when the product id differs", async () => {
    strapi.entityService.findMany.mockResolvedValueOnce([
      { id: 1, Slug: "%d8%b3-y00574", product: { id: 99 } },
    ]);
    await ensureProductSlugAlias(strapi, "%d8%b3-y00574", 2833);
    expect(strapi.entityService.update).toHaveBeenCalledWith(
      "api::product-slug-alias.product-slug-alias",
      1,
      { data: { product: 2833 } },
    );
  });
});
