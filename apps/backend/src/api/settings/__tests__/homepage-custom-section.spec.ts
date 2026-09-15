jest.mock("../../../audit/writer", () => ({ writeAuditEvent: jest.fn(async () => undefined) }));

import controllerFactory from "../controllers/settings";

function buildCtx(payload: unknown) {
  const ctx: any = {
    request: { body: { data: payload } },
    badRequest: jest.fn((message: string, details?: unknown) => ({ message, details })),
    body: undefined,
  };
  return ctx;
}

/**
 * The route sits behind `product.homepage.manage`, so an authenticated round-trip
 * needs a provisioned operator. These exercise the handler itself: the allowlist,
 * the per-field validation loops, and what is written back to the entity.
 */
describe("updateHomepageCustomSection field contract", () => {
  const stored: Record<string, unknown> = { id: 1 };
  const strapi: any = {
    db: {
      query: () => ({ findOne: async () => stored, create: async () => stored }),
      transaction: async (fn: any) => fn({ trx: {} }),
    },
    entityService: {
      findMany: async () => stored,
      update: async (_uid: string, _id: number, { data }: any) => Object.assign(stored, data),
      create: async () => stored,
    },
    log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    contentType: () => ({ uid: "api::settings.settings", attributes: {}, kind: "singleType" }),
    getModel: () => ({ uid: "api::settings.settings", attributes: {}, kind: "singleType" }),
  };
  const controller: any = (controllerFactory as any)({ strapi });

  it.each([
    "javascript:alert(1)",
    "//evil.com",
    "https://evil.com",
  ])("rejects %s with a 400", async (href) => {
    const ctx = buildCtx({ homeCustomSectionViewAllHref: href });
    await controller.updateHomepageCustomSection(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(
      "homeCustomSectionViewAllHref must be an internal path starting with /",
    );
  });

  it("rejects a field outside the allowlist", async () => {
    const ctx = buildCtx({ homeHeroSliderPublished: { slides: [] } });
    await controller.updateHomepageCustomSection(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Homepage custom section payload contains protected settings fields",
      { fields: ["homeHeroSliderPublished"] },
    );
  });

  it("accepts and persists a full third-section payload", async () => {
    const ctx = buildCtx({
      homeCustomSectionThreeEnabled: true,
      homeCustomSectionThreeTitle: "  تست  ",
      homeCustomSectionThreeAssignment: { mode: "category", categorySlug: "manto" },
      homeCustomSectionThreeViewAllHref: "  /plp?hasDiscount=true  ",
    });
    await controller.updateHomepageCustomSection(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(stored.homeCustomSectionThreeEnabled).toBe(true);
    expect(stored.homeCustomSectionThreeTitle).toBe("تست");
    expect(stored.homeCustomSectionThreeViewAllHref).toBe("/plp?hasDiscount=true");
    expect(stored.homeCustomSectionThreeAssignment).toEqual({
      mode: "category",
      categorySlug: "manto",
      productIds: [],
    });
    expect(ctx.body.data.attributes.homeCustomSectionThreeViewAllHref).toBe("/plp?hasDiscount=true");
    expect(ctx.body.data.attributes.homeCustomSectionThreeEnabled).toBe(true);
  });
});
