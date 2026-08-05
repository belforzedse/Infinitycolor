jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, extension: any) => (params: any) => {
      const base = {
        create: jest.fn(async () => ({ data: { id: 1 } })),
        update: jest.fn(async () => ({ data: { id: 1 } })),
      };
      const controller = extension(params);
      Object.setPrototypeOf(controller, base);
      return controller;
    },
  },
}));

import controllerImport from "../controllers/product-stock";

const createCtx = (data: Record<string, unknown>) => ({
  state: { user: { id: 7, role: { name: "Store manager" } } },
  request: { body: { data } },
  badRequest: jest.fn(),
});

describe("product stock operational field contract", () => {
  const controller = (controllerImport as any)({ strapi: {} });
  const base = Object.getPrototypeOf(controller);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("allows Count and product_variation on create", async () => {
    const ctx = createCtx({ Count: 5, product_variation: 12 });
    await controller.create(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(base.create).toHaveBeenCalledWith(ctx);
  });

  it("allows only Count on update", async () => {
    const ctx = createCtx({ Count: 9 });
    await controller.update(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(base.update).toHaveBeenCalledWith(ctx);
  });

  it("rejects raw reservedCount writes", async () => {
    const ctx = createCtx({ Count: 9, reservedCount: 0 });
    await controller.update(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Store manager cannot write protected fields: reservedCount",
    );
    expect(base.update).not.toHaveBeenCalled();
  });
});
