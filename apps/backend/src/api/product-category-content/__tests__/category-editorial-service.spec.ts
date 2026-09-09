const mockStrapi: any = {};
const mockWriteAuditEvent = jest.fn();
const mockRevalidate = jest.fn();

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreService: (_uid: string, factory: any) => factory({ strapi: mockStrapi }),
  },
}));
jest.mock("../../../audit/writer", () => ({
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
}));
jest.mock("../../../utils/revalidate", () => ({
  triggerFrontendRevalidation: (...args: unknown[]) => mockRevalidate(...args),
}));

import service from "../services/product-category-content";

describe("category editorial service", () => {
  const trx = { id: "editorial-trx", raw: jest.fn().mockResolvedValue(undefined) };
  const existing = {
    id: 8,
    Title: "قدیمی",
    Paragraph: "مقدمه",
    Content: "<p>متن</p>",
    IsPublished: false,
    IsRTL: true,
    updatedAt: "2026-09-08T08:00:00.000Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockWriteAuditEvent.mockResolvedValue({ id: 1 });
    mockRevalidate.mockResolvedValue({ attempted: 1, successful: 1, failed: 0 });
    mockStrapi.db = {
      transaction: jest.fn(async (callback: any) => callback({ trx })),
      query: jest.fn(() => ({ findOne: jest.fn().mockResolvedValue(existing) })),
    };
    mockStrapi.entityService = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce({ id: 3, Title: "روسری", Slug: "روسری" })
        .mockResolvedValueOnce({
          id: 3,
          Title: "روسری",
          Slug: "روسری",
          product_category_content: {
            ...existing,
            Title: "راهنمای روسری",
            IsPublished: true,
          },
        }),
      update: jest.fn().mockResolvedValue({
        ...existing,
        Title: "راهنمای روسری",
        Content: "<p>متن تازه</p>",
        IsPublished: true,
      }),
      create: jest.fn(),
      findMany: jest.fn(),
    };
  });

  it("upserts transactionally, writes a bounded audit, and revalidates the exact slug", async () => {
    const result = await (service as any).upsert(
      3,
      {
        Title: "راهنمای روسری",
        Paragraph: "مقدمه",
        Content: "<p>متن تازه</p>",
        IsPublished: true,
        IsRTL: true,
      },
      existing.updatedAt,
    );

    expect(mockStrapi.entityService.update).toHaveBeenCalledWith(
      "api::product-category-content.product-category-content",
      8,
      expect.objectContaining({ transacting: trx }),
    );
    const updateData = mockStrapi.entityService.update.mock.calls[0][2].data;
    expect(updateData).not.toHaveProperty("Audio");
    expect(trx.raw).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock(?, ?)", [17347073, 3]);
    expect(mockWriteAuditEvent).toHaveBeenCalledWith(
      mockStrapi,
      expect.objectContaining({
        eventKey: "content.changed",
        metadata: expect.objectContaining({
          categoryId: 3,
          categorySlug: "روسری",
          changedFields: expect.arrayContaining(["Title", "Content", "IsPublished"]),
        }),
      }),
      { trx },
    );
    const auditInput = mockWriteAuditEvent.mock.calls[0][1];
    expect(JSON.stringify(auditInput)).not.toContain("متن تازه");
    expect(mockRevalidate).toHaveBeenCalledWith(
      { type: "category-editorial", slug: "روسری" },
      "Category Editorial",
    );
    expect(result.kind).toBe("saved");
  });

  it("rejects stale writes without updating or revalidating", async () => {
    const result = await (service as any).upsert(
      3,
      { Title: "عنوان", Paragraph: "متن", IsPublished: false },
      "2026-09-07T08:00:00.000Z",
    );
    expect(result.kind).toBe("conflict");
    expect(mockStrapi.entityService.update).not.toHaveBeenCalled();
    expect(mockWriteAuditEvent).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("projects only published content attached to the exact requested slug", async () => {
    mockStrapi.entityService.findMany.mockResolvedValue([
      {
        id: 3,
        Slug: "روسری",
        product_category_content: {
          id: 8,
          Title: "راهنمای روسری",
          Paragraph: "مقدمه",
          Content: "<p>متن امن</p>",
          IsPublished: true,
          IsRTL: true,
          Audio: {
            id: 71,
            name: "guide.mp3",
            mime: "audio/mpeg",
            url: "/uploads/guide.mp3",
          },
          updatedAt: existing.updatedAt,
        },
      },
    ]);
    await expect((service as any).getPublicBySlug("روسری")).resolves.toEqual(
      expect.objectContaining({
        id: 8,
        title: "راهنمای روسری",
        content: "<p>متن امن</p>",
        audio: {
          name: "guide.mp3",
          mime: "audio/mpeg",
          url: "/uploads/guide.mp3",
        },
        seoDescription: "مقدمه متن امن",
      }),
    );
    expect(mockStrapi.entityService.findMany).toHaveBeenCalledWith(
      "api::product-category.product-category",
      expect.objectContaining({ filters: { Slug: "روسری" }, limit: 1 }),
    );

    mockStrapi.entityService.findMany.mockResolvedValueOnce([
      { id: 4, Slug: "شال", product_category_content: { ...existing, IsPublished: false } },
    ]);
    await expect((service as any).getPublicBySlug("شال")).resolves.toBeNull();
  });
});
