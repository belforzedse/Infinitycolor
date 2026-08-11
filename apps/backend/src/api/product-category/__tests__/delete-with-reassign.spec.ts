const mockStrapi: any = {};
const mockWriteAuditEvent = jest.fn();

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, factory: any) => {
      const controller = factory({ strapi: mockStrapi });
      Object.setPrototypeOf(controller, {
        create: jest.fn(),
        update: jest.fn(),
      });
      return controller;
    },
  },
}));

jest.mock("../../../audit/writer", () => ({
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
}));

jest.mock("../../../utils/audit-context", () => ({
  getAuditContext: () => ({ requestId: "request-123" }),
}));

import controller from "../controllers/product-category";

describe("product category delete-with-reassign audit contract", () => {
  const trx = { id: "category-transaction" };
  const productUpdate = jest.fn();
  const productFindMany = jest.fn();
  const contentFindMany = jest.fn();
  const contentDelete = jest.fn();
  const categoryDelete = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockWriteAuditEvent.mockResolvedValue({
      id: 1,
      eventId: "47a3b819-0dba-43e2-8327-08bf0df419d8",
      deduplicated: false,
    });
    mockStrapi.entityService = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce({ id: 8, Title: "قدیمی", Slug: "old", children: [] })
        .mockResolvedValueOnce({ id: 9, Title: "جدید", Slug: "new" }),
      update: productUpdate.mockResolvedValue({ id: 101 }),
    };
    productFindMany
      .mockResolvedValueOnce([{ id: 101 }, { id: 102 }])
      .mockResolvedValueOnce([
        { id: 102, product_other_categories: [{ id: 8 }, { id: 12 }] },
        { id: 103, product_other_categories: [{ id: 8 }] },
      ]);
    contentFindMany.mockResolvedValue([{ id: 201 }]);
    contentDelete.mockResolvedValue({ id: 201 });
    categoryDelete.mockResolvedValue({ id: 8 });
    mockStrapi.db = {
      transaction: jest.fn(async (callback: any) => callback({ trx })),
      query: jest.fn((uid: string) => {
        if (uid === "api::product.product") return { findMany: productFindMany };
        if (uid === "api::product-category-content.product-category-content") {
          return { findMany: contentFindMany, delete: contentDelete };
        }
        if (uid === "api::product-category.product-category") {
          return { delete: categoryDelete };
        }
        throw new Error(`Unexpected query UID: ${uid}`);
      }),
    };
  });

  const createContext = () => ({
    params: { id: "8" },
    request: { body: { targetCategoryId: 9 } },
    badRequest: jest.fn(),
    notFound: jest.fn(),
  });

  it("commits every mutation and its canonical summary in one transaction", async () => {
    const response = await controller.deleteWithReassign(createContext() as any);

    expect(productUpdate).toHaveBeenNthCalledWith(
      1,
      "api::product.product",
      101,
      expect.objectContaining({ data: { product_main_category: 9 }, transacting: trx }),
    );
    expect(productUpdate).toHaveBeenNthCalledWith(
      3,
      "api::product.product",
      102,
      expect.objectContaining({ data: { product_other_categories: [12] }, transacting: trx }),
    );
    expect(contentDelete).toHaveBeenCalledWith({ where: { id: 201 }, transacting: trx });
    expect(categoryDelete).toHaveBeenCalledWith({ where: { id: 8 }, transacting: trx });
    expect(mockWriteAuditEvent).toHaveBeenCalledWith(
      mockStrapi,
      expect.objectContaining({
        eventKey: "categories.deleted_with_reassignment",
        result: "success",
        target: expect.objectContaining({ type: "category", id: 8, label: "قدیمی" }),
        related: expect.objectContaining({ type: "category", id: 9, label: "جدید" }),
        metadata: expect.objectContaining({
          affectedProductCount: 3,
          mainCategoryReassignedCount: 2,
          otherCategoryReferencesRemoved: 2,
          categoryContentRecordsDeleted: 1,
        }),
        dedupeKey: "category-delete-reassign:8:9:request-123",
      }),
      { trx },
    );
    expect(response).toEqual({ data: { success: true, reassignedCount: 2 } });
  });

  it("fails the operation when the required audit write fails", async () => {
    mockWriteAuditEvent.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(controller.deleteWithReassign(createContext() as any)).rejects.toThrow(
      "audit unavailable",
    );
  });
});
