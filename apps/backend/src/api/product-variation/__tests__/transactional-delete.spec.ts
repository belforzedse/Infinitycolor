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

const clearProductOriginCaches = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../utils/productOriginCache", () => ({
  clearProductOriginCaches: (...args: unknown[]) => clearProductOriginCaches(...args),
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
    mockStrapi.entityService = {
      findMany: jest.fn(async () => []),
      findOne: jest.fn(async () => null),
    };
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
      "This role cannot write protected fields: product, AttributeSignature",
    );
    expect(base.update).not.toHaveBeenCalled();
  });

  it("derives a canonical signature for admin-created generic variations", async () => {
    mockStrapi.entityService.findMany.mockResolvedValue([
      { id: 725, product_attribute: { id: 31 } },
    ]);
    const ctx = createCtx({
      product: 4557,
      SKU: "SKU-CUSTOM",
      Price: 299000,
      IsPublished: false,
      selected_attribute_terms: [725],
    });
    await controller.create(ctx as any);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(ctx.request.body.data.AttributeSignature).toBe(
      "attribute:31=725",
    );
    expect(base.create).toHaveBeenCalledWith(ctx);
  });
});

describe("changing one variation's colour", () => {
  const base = Object.getPrototypeOf(controller);
  const updateCtx = (data: Record<string, unknown>) => ({
    params: { id: "11" },
    state: { user: { id: 7, role: { name: "Store manager" } } },
    request: { body: { data } },
    badRequest: jest.fn(),
    notFound: jest.fn(),
    conflict: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockStrapi.entityService = {
      // The variation being edited: red, size S, on product 5.
      findOne: jest.fn(async () => ({
        id: 11,
        product: { id: 5, Slug: "shirt" },
        product_variation_color: { id: 1 },
        product_variation_size: { id: 21 },
        product_variation_model: null,
        selected_attribute_terms: [],
      })),
      // Its siblings: itself, and blue in size S.
      findMany: jest.fn(async () => [
        { id: 11, AttributeSignature: "color=1|size=21" },
        { id: 14, AttributeSignature: "color=2|size=21" },
      ]),
    };
  });

  it("refuses a colour that would duplicate another variation of the product", async () => {
    const ctx = updateCtx({ product_variation_color: 2 });
    await controller.update(ctx as any);

    expect(ctx.conflict).toHaveBeenCalledWith(expect.any(String), {
      data: { errorCode: "VARIATION_SIGNATURE_EXISTS", variationId: 14 },
    });
    expect(base.update).not.toHaveBeenCalled();
    expect(clearProductOriginCaches).not.toHaveBeenCalled();
  });

  it("saves a free colour and refreshes that product's storefront pages", async () => {
    const ctx = updateCtx({ product_variation_color: 3 });
    await controller.update(ctx as any);

    expect(ctx.conflict).not.toHaveBeenCalled();
    expect(ctx.request.body.data.AttributeSignature).toBe("color=3|size=21");
    expect(base.update).toHaveBeenCalledWith(ctx);
    expect(clearProductOriginCaches).toHaveBeenCalledWith(mockStrapi, "shirt", {
      availabilityCrossed: true,
      logPrefix: "variation-color",
    });
  });

  it("leaves caches alone when the colour did not change", async () => {
    const ctx = updateCtx({ product_variation_color: 1, Price: 120 });
    await controller.update(ctx as any);

    expect(base.update).toHaveBeenCalledWith(ctx);
    expect(clearProductOriginCaches).not.toHaveBeenCalled();
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
