import lifecycles from "../lifecycles";
import { afterCatalogCommit } from "../../../utils/catalogEdit";
import { refreshProductKeywords } from "../services/product-title-keywords-refresh";

jest.mock("../../../utils/catalogEdit", () => ({
  afterCatalogCommit: jest.fn(),
  runCatalogSystemMutation: jest.fn(),
}));

jest.mock("../services/product-title-keywords-refresh", () => ({
  refreshProductKeywords: jest.fn(),
}));

const mockedAfterCommit = jest.mocked(afterCatalogCommit);
const mockedRefresh = jest.mocked(refreshProductKeywords);

describe("product keywords lifecycle", () => {
  const mockStrapi = global.strapi as any;

  let effects: Array<() => Promise<unknown>>;

  beforeEach(() => {
    jest.clearAllMocks();
    effects = [];

    mockedRefresh.mockReset();
    mockedRefresh.mockResolvedValue(undefined);

    mockedAfterCommit.mockImplementation(async (_strapi, effect) => {
      effects.push(effect);
    });

    mockStrapi.entityService.findOne.mockResolvedValue({
      product_size_helper: { id: 1 },
    });
  });

  it("schedules a refresh after product creation", async () => {
    await lifecycles.afterCreate({ result: { id: 1 } }, undefined);

    expect(effects).toHaveLength(1);
    expect(mockedRefresh).not.toHaveBeenCalled();

    await effects[0]();

    expect(mockedRefresh).toHaveBeenCalledWith(mockStrapi);
  });

  it("schedules a refresh when the update includes a title", async () => {
    await lifecycles.afterUpdate({
      params: { data: { Title: "شومیز نخی" } },
    });

    expect(effects).toHaveLength(1);
    expect(mockedRefresh).not.toHaveBeenCalled();

    await effects[0]();

    expect(mockedRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh for an update without a title", async () => {
    await lifecycles.afterUpdate({
      params: { data: { Weight: 200 } },
    });

    expect(mockedAfterCommit).not.toHaveBeenCalled();
    expect(mockedRefresh).not.toHaveBeenCalled();
  });

  it("logs a refresh failure without rejecting the effect", async () => {
    const error = new Error("Cannot rebuild keywords");
    mockedRefresh.mockRejectedValueOnce(error);

    await lifecycles.afterUpdate({
      params: { data: { Title: "شومیز" } },
    });

    await expect(effects[0]()).resolves.toBeUndefined();

    expect(mockStrapi.log.error).toHaveBeenCalledWith(
      "Product keywords refresh after save failed",
      error,
    );
  });
});
