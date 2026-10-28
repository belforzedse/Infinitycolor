import lifecycles from "../lifecycles";
import { runCatalogSystemMutation } from "../../../utils/catalogEdit";

jest.mock("../../../utils/catalogEdit", () => ({
  runCatalogSystemMutation: jest.fn(),
}));

describe("product initialization lifecycle", () => {
  const strapi = global.strapi as any;

  beforeEach(() => {
    jest.clearAllMocks();
    delete strapi.requestContext;
    jest.mocked(runCatalogSystemMutation).mockImplementation(async (_strapi, _ids, _reason, effect) => effect());
  });

  it("preserves an existing size helper", async () => {
    strapi.entityService.findOne.mockResolvedValue({ product_size_helper: { id: 10 } });

    await lifecycles.afterCreate({ result: { id: 1 } }, undefined);

    expect(strapi.entityService.create).not.toHaveBeenCalled();
    expect(runCatalogSystemMutation).not.toHaveBeenCalled();
  });

  it("creates a missing helper outside a request", async () => {
    strapi.entityService.findOne.mockResolvedValue({ product_size_helper: null });

    await lifecycles.afterCreate({ result: { id: 1 } }, undefined);

    expect(strapi.entityService.create).toHaveBeenCalledWith("api::product-size-helper.product-size-helper", {
      data: { product: 1, Helper: {} },
    });
    expect(runCatalogSystemMutation).not.toHaveBeenCalled();
  });

  it("keeps the catalog initialization guard for an authenticated request", async () => {
    strapi.entityService.findOne.mockResolvedValue({ product_size_helper: null });
    strapi.requestContext = { get: () => ({ state: { user: { id: 2 } } }) };

    await lifecycles.afterCreate({ result: { id: 1 } }, undefined);

    expect(runCatalogSystemMutation).toHaveBeenCalledWith(
      strapi, [1], "catalog-initialization", expect.any(Function),
    );
    expect(strapi.entityService.create).toHaveBeenCalledTimes(1);
  });
});
