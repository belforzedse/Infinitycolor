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

  it("never touches a row this importer did not write", async () => {
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
    expect(result).toEqual(expect.objectContaining({ mode: "skipped", reason: "manual" }));
    expect(h.fileQuery.findOne).not.toHaveBeenCalled();
    expect(h.contentQuery.create).not.toHaveBeenCalled();
  });

  it("carries a source edit into the row it wrote, keeping publication as the shop left it", async () => {
    const h = harness();
    h.categoryQuery.findOne.mockResolvedValue({
      id: 20,
      Title: "مانتو",
      Slug: "manto",
      external_id: "10",
      external_source: "woocommerce",
    });
    const previousHash = categoryEditorialSourceHash({
      sourceId: "10",
      destinationSlug: "manto",
      title: "راهنمای مانتو",
      paragraph: "مقدمه قدیمی",
      content: "<p>متن قدیمی</p>",
      audioHash: null,
    } as any);
    h.contentQuery.findOne.mockResolvedValue({
      id: 31,
      Title: "راهنمای مانتو",
      Paragraph: "مقدمه قدیمی",
      Content: "<p>متن قدیمی</p>",
      IsPublished: true,
      IsRTL: true,
      ImportSource: "woocommerce-category-description",
      ImportBatchId: "category-seo-00000000",
      ImportedSourceHash: previousHash,
      Audio: null,
    });
    h.contentQuery.update.mockResolvedValue({ id: 31 });

    const result = await prepareCategoryEditorial(h.strapi, {
      batchId: "category-seo-12345678",
      sourceId: "10",
      categoryId: 20,
      sourceHash: sourceHash(),
      data: { Title: "راهنمای مانتو", Paragraph: "مقدمه", Content: "<p>متن</p>" },
      audio: null,
    });

    expect(result).toEqual(expect.objectContaining({ mode: "updated", id: 31, isPublished: true }));
    const written = h.contentQuery.update.mock.calls[0][0].data;
    expect(written.Content).toBe("<p>متن</p>");
    expect(written.IsPublished).toBe(true);
    expect(written.ImportBatchId).toBe("category-seo-12345678");
    expect(written.ImportedSourceHash).toBe(sourceHash());
    expect(h.contentQuery.create).not.toHaveBeenCalled();
  });

  it("writes nothing when the source has not moved since the row was imported", async () => {
    const h = harness();
    h.categoryQuery.findOne.mockResolvedValue({
      id: 20,
      Title: "مانتو",
      Slug: "manto",
      external_id: "10",
      external_source: "woocommerce",
    });
    h.contentQuery.findOne.mockResolvedValue({
      id: 31,
      Title: "راهنمای مانتو",
      Paragraph: "مقدمه",
      Content: "<p>متن</p>",
      IsPublished: true,
      IsRTL: true,
      ImportSource: "woocommerce-category-description",
      ImportBatchId: "category-seo-12345678",
      ImportedSourceHash: sourceHash(),
      Audio: null,
    });

    const result = await prepareCategoryEditorial(h.strapi, {
      batchId: "category-seo-12345678",
      sourceId: "10",
      categoryId: 20,
      sourceHash: sourceHash(),
      data: { Title: "راهنمای مانتو", Paragraph: "مقدمه", Content: "<p>متن</p>" },
      audio: null,
    });

    expect(result).toEqual(expect.objectContaining({ mode: "skipped", reason: "unchanged", id: 31 }));
    expect(h.contentQuery.update).not.toHaveBeenCalled();
    expect(h.contentQuery.create).not.toHaveBeenCalled();
  });

  it("adopts an unpublished row a previous batch left behind", async () => {
    const h = harness();
    h.categoryQuery.findOne.mockResolvedValue({
      id: 20,
      Title: "مانتو",
      Slug: "manto",
      external_id: "10",
      external_source: "woocommerce",
    });
    // Same content, never published, stamped with an earlier batch: without
    // adoption the row can never be finalized, because finalize only ever
    // looks at rows carrying the current batch id.
    h.contentQuery.findOne.mockResolvedValue({
      id: 31,
      Title: "راهنمای مانتو",
      Paragraph: "مقدمه",
      Content: "<p>متن</p>",
      IsPublished: false,
      IsRTL: true,
      ImportSource: "woocommerce-category-description",
      ImportBatchId: "category-seo-aaaaaaaa",
      ImportedSourceHash: sourceHash(),
      Audio: null,
    });
    h.contentQuery.update.mockResolvedValue({ id: 31 });

    const result = await prepareCategoryEditorial(h.strapi, {
      batchId: "category-seo-12345678",
      sourceId: "10",
      categoryId: 20,
      sourceHash: sourceHash(),
      data: { Title: "راهنمای مانتو", Paragraph: "مقدمه", Content: "<p>متن</p>" },
      audio: null,
    });

    expect(result).toEqual(expect.objectContaining({
      mode: "skipped",
      reason: "unchanged",
      adopted: true,
      importBatchId: "category-seo-12345678",
      isPublished: false,
    }));
    // Provenance only: no content and no publication change.
    expect(Object.keys(h.contentQuery.update.mock.calls[0][0].data).sort())
      .toEqual(["ImportBatchId", "ImportedAt"]);
  });

  it("does not overwrite a row an admin edited after the importer wrote it", async () => {
    const h = harness();
    h.categoryQuery.findOne.mockResolvedValue({
      id: 20,
      Title: "مانتو",
      Slug: "manto",
      external_id: "10",
      external_source: "woocommerce",
    });
    // The provenance hash still says what the importer wrote; the row's own
    // text no longer hashes to it, so a person has been here since.
    h.contentQuery.findOne.mockResolvedValue({
      id: 31,
      Title: "راهنمای مانتو",
      Paragraph: "مقدمه‌ای که ادمین بازنویسی کرده",
      Content: "<p>متن</p>",
      IsPublished: true,
      IsRTL: true,
      ImportSource: "woocommerce-category-description",
      ImportBatchId: "category-seo-00000000",
      ImportedSourceHash: categoryEditorialSourceHash({
        sourceId: "10",
        destinationSlug: "manto",
        title: "راهنمای مانتو",
        paragraph: "مقدمه قدیمی",
        content: "<p>متن</p>",
        audioHash: null,
      } as any),
      Audio: null,
    });

    const result = await prepareCategoryEditorial(h.strapi, {
      batchId: "category-seo-12345678",
      sourceId: "10",
      categoryId: 20,
      sourceHash: sourceHash(),
      data: { Title: "راهنمای مانتو", Paragraph: "مقدمه", Content: "<p>متن</p>" },
      audio: null,
    });

    expect(result).toEqual(expect.objectContaining({ mode: "skipped", reason: "manually-edited", id: 31 }));
    expect(h.contentQuery.update).not.toHaveBeenCalled();
  });

  it("does not detach an audio file a person attached to an imported row", async () => {
    const h = harness();
    h.categoryQuery.findOne.mockResolvedValue({
      id: 20,
      Title: "مانتو",
      Slug: "manto",
      external_id: "10",
      external_source: "woocommerce",
    });
    // Text identical to what the importer wrote (so the text hash still
    // matches), but the row now carries an audio file the importer never
    // uploaded — its name does not carry the hash of its bytes.
    h.contentQuery.findOne.mockResolvedValue({
      id: 31,
      Title: "راهنمای مانتو",
      Paragraph: "مقدمه قدیمی",
      Content: "<p>متن قدیمی</p>",
      IsPublished: true,
      IsRTL: true,
      ImportSource: "woocommerce-category-description",
      ImportBatchId: "category-seo-00000000",
      ImportedSourceHash: categoryEditorialSourceHash({
        sourceId: "10",
        destinationSlug: "manto",
        title: "راهنمای مانتو",
        paragraph: "مقدمه قدیمی",
        content: "<p>متن قدیمی</p>",
        audioHash: null,
      } as any),
      Audio: { id: 99, name: "my-recording.mp3", mime: "audio/mpeg", url: "/uploads/my-recording.mp3", size: 120 },
    });

    const result = await prepareCategoryEditorial(h.strapi, {
      batchId: "category-seo-12345678",
      sourceId: "10",
      categoryId: 20,
      sourceHash: sourceHash(),
      data: { Title: "راهنمای مانتو", Paragraph: "مقدمه", Content: "<p>متن</p>" },
      audio: null,
    });

    expect(result).toEqual(expect.objectContaining({ mode: "skipped", reason: "manually-edited" }));
    expect(h.contentQuery.update).not.toHaveBeenCalled();
  });

  it("publishes only the unpublished rows of a batch that also carries updates", async () => {
    const h = harness();
    const hash = sourceHash();
    const otherHash = sourceHash({ sourceId: "11", destinationSlug: "shawl" });
    const row = (id: number, categoryId: number, slug: string, sourceId: string, published: boolean, rowHash: string) => ({
      id,
      Title: "راهنمای مانتو",
      Paragraph: "مقدمه",
      Content: "<p>متن</p>",
      IsPublished: published,
      IsRTL: true,
      ImportSource: "woocommerce-category-description",
      ImportBatchId: "category-seo-12345678",
      ImportedSourceHash: rowHash,
      product_category: { id: categoryId, Slug: slug, external_id: sourceId, external_source: "woocommerce" },
      Audio: null,
    });
    h.contentQuery.findMany.mockResolvedValue([
      row(30, 20, "manto", "10", false, hash),
      row(31, 21, "shawl", "11", true, otherHash),
    ]);
    h.contentQuery.update.mockResolvedValue({ id: 30, IsPublished: true });

    const result = await finalizeCategoryEditorial(h.strapi, {
      batchId: "category-seo-12345678",
      entries: [
        { sourceId: "10", categoryId: 20, editorialId: 30, sourceHash: hash, audio: null },
        { sourceId: "11", categoryId: 21, editorialId: 31, sourceHash: otherHash, audio: null },
      ],
    });

    expect(result).toEqual(expect.objectContaining({ mode: "published", published: 1, alreadyPublished: 1 }));
    expect(h.contentQuery.update).toHaveBeenCalledTimes(1);
    expect(h.contentQuery.update.mock.calls[0][0].where).toEqual({ id: 30 });
    // Both pages are revalidated: the updated row's copy changed even though
    // its publication state did not.
    expect(mockRevalidate).toHaveBeenCalledTimes(2);
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
