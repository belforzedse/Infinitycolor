const mockStrapi: any = {};
const mockWriteAuditEvent = jest.fn();

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, factory: any) => factory({ strapi: mockStrapi }),
  },
}));

jest.mock("../../../audit/writer", () => ({
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
}));

jest.mock("../../../utils/audit-context", () => ({
  getAuditContext: () => ({ requestId: "settings-request" }),
}));

jest.mock("../../../utils/revalidate", () => ({
  getFrontendUrls: () => [],
}));

import controller from "../controllers/settings";

describe("settings canonical audit writes", () => {
  const trx = { id: "settings-trx" };
  const findSettings = jest.fn();
  const updateSettings = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockWriteAuditEvent.mockResolvedValue({
      id: 1,
      eventId: "3f469240-d7ac-4f80-b40a-3635b9da0751",
      deduplicated: false,
    });
    mockStrapi.log = {
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    };
    mockStrapi.db = {
      query: jest.fn(() => ({ findOne: findSettings })),
      transaction: jest.fn(async (callback: any) => callback({ trx })),
    };
    mockStrapi.entityService = {
      create: jest.fn(),
      update: updateSettings,
    };
  });

  it("writes changed blog-banner fields in the owning transaction", async () => {
    findSettings.mockResolvedValue({
      id: 5,
      blogDefaultBannerTitle: "قدیمی",
      blogDefaultBannerSubtitle: "",
    });
    updateSettings.mockResolvedValue({
      id: 5,
      blogDefaultBannerTitle: "جدید",
      blogDefaultBannerSubtitle: "",
    });
    const ctx: any = {
      request: { body: { data: { blogDefaultBannerTitle: " جدید " } } },
      badRequest: jest.fn(),
    };

    await controller.updateBlogBanners(ctx);

    expect(updateSettings).toHaveBeenCalledWith(
      "api::settings.settings",
      5,
      expect.objectContaining({
        data: { blogDefaultBannerTitle: "جدید" },
        transacting: trx,
      }),
    );
    expect(mockWriteAuditEvent).toHaveBeenCalledWith(
      mockStrapi,
      expect.objectContaining({
        eventKey: "content.changed",
        result: "success",
        target: expect.objectContaining({ type: "settings", id: 5, label: "بنرهای وبلاگ" }),
        changes: [
          expect.objectContaining({
            field: "blogDefaultBannerTitle",
            from: "قدیمی",
            to: "جدید",
          }),
        ],
        dedupeKey: "settings:blog-banners:5:settings-request",
      }),
      { trx },
    );
  });

  it("records a bounded hero-slider summary instead of the full configuration", async () => {
    findSettings.mockResolvedValue({
      id: 5,
      homeHeroSliderDraft: { version: 3, slides: [] },
    });
    const draft = {
      version: 3,
      slides: [
        {
          id: "slide-1",
          imageUrl: "/uploads/hero.webp",
          imageAlt: "Hero",
          link: { type: "internal", href: "/products" },
          isActive: true,
        },
      ],
    };
    updateSettings.mockResolvedValue({ id: 5, homeHeroSliderDraft: draft });
    const ctx: any = {
      request: { body: { data: draft } },
      badRequest: jest.fn(),
    };

    await controller.updateHeroSliderDraft(ctx);

    expect(mockWriteAuditEvent).toHaveBeenCalledWith(
      mockStrapi,
      expect.objectContaining({
        eventKey: "content.changed",
        result: "success",
        changes: [
          expect.objectContaining({
            field: "homeHeroSliderDraft",
            from: expect.objectContaining({ slideCount: 0 }),
            to: expect.objectContaining({ slideCount: 1, activeSlideCount: 1 }),
          }),
        ],
        metadata: { section: "homepage_slider", stage: "draft" },
      }),
      { trx },
    );
  });

  it("does not commit a settings mutation without its required audit event", async () => {
    findSettings.mockResolvedValue({ id: 5, blogDefaultBannerTitle: "قدیمی" });
    updateSettings.mockResolvedValue({ id: 5, blogDefaultBannerTitle: "جدید" });
    mockWriteAuditEvent.mockRejectedValueOnce(new Error("audit unavailable"));
    const ctx: any = {
      request: { body: { data: { blogDefaultBannerTitle: "جدید" } } },
      badRequest: jest.fn(),
    };

    await expect(controller.updateBlogBanners(ctx)).rejects.toThrow("audit unavailable");
  });
});
