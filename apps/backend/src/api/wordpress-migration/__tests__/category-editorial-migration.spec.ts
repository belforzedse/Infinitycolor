const mockRevalidate = jest.fn();

jest.mock("../../../utils/revalidate", () => ({
  triggerFrontendRevalidation: (...args: unknown[]) => mockRevalidate(...args),
}));

import {
  categoryEditorialSourceHash,
  finalizeCategoryEditorial,
  prepareCategoryEditorial,
} from "../services/category-editorial-migration";

const CONTENT_UID = "api::product-category-content.product-category-content";
const CATEGORY_UID = "api::product-category.product-category";
const FILE_UID = "plugin::upload.file";
const SOURCE_HASH = "a".repeat(64);

function harness() {
  const trx = { raw: jest.fn().mockResolvedValue(undefined) };
  const categoryQuery = { findOne: jest.fn() };
  const contentQuery = {
    findOne: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const fileQuery = { findOne: jest.fn() };
  const query = jest.fn((uid: string) => {
    if (uid === CATEGORY_UID) return categoryQuery;
    if (uid === CONTENT_UID) return contentQuery;
    if (uid === FILE_UID) return fileQuery;
    throw new Error(`unexpected uid ${uid}`);
  });
  const strapi: any = {
    db: {
      query,
      transaction: jest.fn(async (callback: any) => callback({ trx })),
    },
  };
  return { strapi, trx, categoryQuery, contentQuery, fileQuery };
}

function sourceHash(overrides: Record<string, unknown> = {}) {
  return categoryEditorialSourceHash({
    sourceId: "10",
    destinationSlug: "manto",
    title: "راهنمای مانتو",
    paragraph: "مقدمه",
    content: "<p>متن</p>",
    audioHash: null,
    ...overrides,
  } as any);
}

describe("category editorial migration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRevalidate.mockResolvedValue({ attempted: 1, successful: 1, failed: 0 });
  });

  it("prepares a missing row as an unpublished, provenance-bound draft", async () => {
    const h = harness();
    h.categoryQuery.findOne.mockResolvedValue({
      id: 20,
      Title: "مانتو",
      Slug: "manto",
      external_id: "10",
      external_source: "woocommerce",
    });
    h.contentQuery.findOne.mockResolvedValue(null);
    h.contentQuery.create.mockResolvedValue({ id: 30 });
    const hash = sourceHash();

    const result = await prepareCategoryEditorial(h.strapi, {
      batchId: "category-seo-12345678",
      sourceId: "10",
      categoryId: 20,
      sourceHash: hash,
      data: {
        Title: "راهنمای مانتو",
        Paragraph: "مقدمه",
        Content: "<p>متن</p>",
        IsPublished: true,
      },
      audio: null,
    });

    expect(result).toEqual(expect.objectContaining({ mode: "prepared", id: 30 }));
    expect(h.contentQuery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          IsPublished: false,
          product_category: 20,
          ImportSource: "woocommerce-category-description",
          ImportBatchId: "category-seo-12345678",
          ImportedSourceHash: hash,
        }),
        transacting: h.trx,
      }),
    );
  });

  it("preserves every existing manual or imported row without media or editorial writes", async () => {
    const h = harness();
    h.categoryQuery.findOne.mockResolvedValue({
      id: 20,
      Slug: "manto",
      external_id: "10",
      external_source: "woocommerce",
    });
    h.contentQuery.findOne.mockResolvedValue({
      id: 31,
      IsPublished: true,
      ImportBatchId: null,
      ImportedSourceHash: null,
    });
    const result = await prepareCategoryEditorial(h.strapi, {
      batchId: "category-seo-12345678",
      sourceId: "10",
      categoryId: 20,
      sourceHash: sourceHash(),
      data: { Title: "راهنمای مانتو", Paragraph: "مقدمه", Content: "<p>متن</p>" },
      audio: { id: 71, sha256: SOURCE_HASH },
    });
    expect(result).toEqual(expect.objectContaining({ mode: "skipped", reason: "existing" }));
    expect(h.fileQuery.findOne).not.toHaveBeenCalled();
    expect(h.contentQuery.create).not.toHaveBeenCalled();
  });

  it("validates the exact batch and publishes all rows in one transaction", async () => {
    const h = harness();
    const hash = sourceHash();
    h.contentQuery.findMany.mockResolvedValue([
      {
        id: 30,
        Title: "راهنمای مانتو",
        Paragraph: "مقدمه",
        Content: "<p>متن</p>",
        IsPublished: false,
        IsRTL: true,
        ImportSource: "woocommerce-category-description",
        ImportBatchId: "category-seo-12345678",
        ImportedSourceHash: hash,
        product_category: {
          id: 20,
          Slug: "manto",
          external_id: "10",
          external_source: "woocommerce",
        },
        Audio: null,
      },
    ]);
    h.contentQuery.update.mockResolvedValue({ id: 30, IsPublished: true });

    const result = await finalizeCategoryEditorial(h.strapi, {
      batchId: "category-seo-12345678",
      entries: [{
        sourceId: "10",
        categoryId: 20,
        editorialId: 30,
        sourceHash: hash,
        audio: null,
      }],
    });

    expect(result).toEqual(expect.objectContaining({ mode: "published", published: 1 }));
    expect(h.contentQuery.update).toHaveBeenCalledWith({
      where: { id: 30 },
      data: { IsPublished: true },
      transacting: h.trx,
    });
    expect(mockRevalidate).toHaveBeenCalledWith(
      { type: "category-editorial", slug: "manto" },
      "Category Editorial Import",
    );
  });

  it("rolls back publication when the transformed content no longer matches", async () => {
    const h = harness();
    h.contentQuery.findMany.mockResolvedValue([
      {
        id: 30,
        Title: "متن دستکاری‌شده",
        Paragraph: "مقدمه",
        Content: "<p>متن</p>",
        IsPublished: false,
        IsRTL: true,
        ImportSource: "woocommerce-category-description",
        ImportBatchId: "category-seo-12345678",
        ImportedSourceHash: sourceHash(),
        product_category: {
          id: 20,
          Slug: "manto",
          external_id: "10",
          external_source: "woocommerce",
        },
        Audio: null,
      },
    ]);

    await expect(finalizeCategoryEditorial(h.strapi, {
      batchId: "category-seo-12345678",
      entries: [{
        sourceId: "10",
        categoryId: 20,
        editorialId: 30,
        sourceHash: sourceHash(),
        audio: null,
      }],
    })).rejects.toMatchObject({ code: "CATEGORY_EDITORIAL_BATCH_CONTENT_MISMATCH" });
    expect(h.contentQuery.update).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});
