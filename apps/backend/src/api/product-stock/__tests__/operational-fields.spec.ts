jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, extension: any) => (params: any) => {
      const base = {
        create: jest.fn(async () => ({ data: { id: 1 } })),
        update: jest.fn(async () => ({ data: { id: 1 } })),
        sanitizeOutput: jest.fn(async (value) => value),
        transformResponse: jest.fn((value) => ({ data: value })),
      };
      const controller = extension(params);
      Object.setPrototypeOf(controller, base);
      return controller;
    },
  },
}));

jest.mock("../../../utils/catalogEdit", () => ({
  ...jest.requireActual("../../../utils/catalogEdit"),
  catalogMutationContext: () => ({ ids: [3], writer: { kind: "human" } }),
}));
const saveEditorStock = jest.fn().mockResolvedValue({ id: 5 });
jest.mock("../../product/controllers/product-editor", () => ({
  saveEditorStock: (...args: unknown[]) => saveEditorStock(...args),
}));

import controllerImport from "../controllers/product-stock";

const createCtx = (data: Record<string, unknown>) => ({
  state: { user: { id: 7, role: { name: "Store manager" } } },
  request: { body: { data } },
  params: { id: "5" },
  get: () => "4",
  badRequest: jest.fn(),
});

describe("product stock operational field contract", () => {
  const strapi = { db: { query: jest.fn(() => ({ findOne: jest.fn(async () => ({ id: 5, product_variation: { id: 12 } })) })) } };
  const controller = (controllerImport as any)({ strapi });
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

  it("writes Count through the guarded stock revision operation", async () => {
    const ctx = createCtx({ Count: 9 });
    await controller.update(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(saveEditorStock).toHaveBeenCalledWith(strapi, 3, 12, { id: 5, Count: 9, expectedStockRevision: "4" });
    expect(base.update).not.toHaveBeenCalled();
  });

  it("rejects raw reservedCount writes", async () => {
    const ctx = createCtx({ Count: 9, reservedCount: 0 });
    await controller.update(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(
      "This role cannot write protected fields: reservedCount",
    );
    expect(base.update).not.toHaveBeenCalled();
  });
});
