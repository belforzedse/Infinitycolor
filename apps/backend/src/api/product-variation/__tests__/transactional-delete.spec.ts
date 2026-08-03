const mockStrapi: any = {};

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, factory: any) => {
      const controller = factory({ strapi: mockStrapi });
      Object.setPrototypeOf(controller, {
        create: jest.fn(async () => ({ data: { id: 11 } })),
        update: jest.fn(async () => ({ data: { id: 11 } })),
      });
      return controller;
    },
  },
}));

import controller from "../controllers/product-variation";

describe("product variation operational field contract", () => {
  const base = Object.getPrototypeOf(controller);
  const createCtx = (data: Record<string, unknown>) => ({
    state: { user: { id: 7, role: { name: "Store manager" } } },
    request: { body: { data } },
    badRequest: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("allows product ownership when creating a variation", async () => {
    const ctx = createCtx({ product: 3, SKU: "SKU-1", Price: 100, IsPublished: false });
    await controller.create(ctx as any);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(base.create).toHaveBeenCalledWith(ctx);
  });

  it("rejects ownership and system fields on update", async () => {
    const ctx = createCtx({ product: 4, AttributeSignature: "color=1" });
    await controller.update(ctx as any);
    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Store manager cannot write protected fields: product, AttributeSignature",
    );
    expect(base.update).not.toHaveBeenCalled();
  });
});

describe("product variation transactional deletion", () => {
  it("deletes dependent stock and variation in the same transaction", async () => {
    const stockDelete = jest.fn().mockResolvedValue({ id: 22 });
    const variationDelete = jest.fn().mockResolvedValue({ id: 11, SKU: "TEST" });
    const variationFind = jest.fn().mockResolvedValue({
      id: 11,
      product_stock: { id: 22, reservedCount: 0 },
    });
    const trx = { id: "trx" };
    mockStrapi.db = {
      transaction: jest.fn(async (callback: any) => callback({ trx })),
      query: jest.fn((uid: string) =>
        uid === "api::product-stock.product-stock"
          ? { delete: stockDelete }
          : { findOne: variationFind, delete: variationDelete },
      ),
    };
    const ctx: any = {
      params: { id: "11" },
      badRequest: jest.fn(),
      notFound: jest.fn(),
    };
    const receiver = {
      sanitizeOutput: jest.fn(async (value) => value),
      transformResponse: jest.fn((value) => ({ data: value })),
    };

    const response = await controller.delete.call(receiver, ctx);

    expect(variationFind).toHaveBeenCalledWith(expect.objectContaining({ transacting: trx }));
    expect(stockDelete).toHaveBeenCalledWith({ where: { id: 22 }, transacting: trx });
    expect(variationDelete).toHaveBeenCalledWith({ where: { id: 11 }, transacting: trx });
    expect(response).toEqual({ data: { id: 11, SKU: "TEST" } });
  });

  it("keeps the variation and stock when inventory is reserved", async () => {
    const stockDelete = jest.fn();
    const variationDelete = jest.fn();
    const variationFind = jest.fn().mockResolvedValue({
      id: 11,
      product_stock: { id: 22, reservedCount: 2 },
    });
    mockStrapi.db = {
      transaction: jest.fn(async (callback: any) => callback({ trx: { id: "trx" } })),
      query: jest.fn((uid: string) =>
        uid === "api::product-stock.product-stock"
          ? { delete: stockDelete }
          : { findOne: variationFind, delete: variationDelete },
      ),
    };
    const ctx: any = {
      params: { id: "11" },
      badRequest: jest.fn(),
      notFound: jest.fn(),
    };

    await expect(controller.delete.call({}, ctx)).rejects.toMatchObject({
      status: 409,
      message: "Reserved inventory prevents variation deletion",
    });
    expect(stockDelete).not.toHaveBeenCalled();
    expect(variationDelete).not.toHaveBeenCalled();
  });
});
