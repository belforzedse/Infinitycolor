const mockIsTrustedWordPressMigrationRequest = jest.fn(() => true);
const mockGenerateUniqueProductSlug = jest.fn(async () => "generated-slug");

jest.mock("../../../utils/migration-context", () => ({
  isTrustedWordPressMigrationRequest: () => mockIsTrustedWordPressMigrationRequest(),
}));

jest.mock("../../../utils/productSlug", () => ({
  generateUniqueProductSlug: (...args: unknown[]) => mockGenerateUniqueProductSlug(...args),
}));

import productLifecycles from "../content-types/product/lifecycles";

describe("trusted WooCommerce product slug preservation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTrustedWordPressMigrationRequest.mockReturnValue(true);
  });

  it("does not derive a slug when WooCommerce supplies an empty slug", async () => {
    const event: any = {
      params: { data: { Title: "Source title", Slug: "" } },
      state: {},
    };

    await productLifecycles.beforeCreate(event);

    expect(event.params.data.Slug).toBe("");
    expect(event.params.data.LastEditedByAdminAt).toBeUndefined();
    expect(event.state.migrationWrite).toBe(true);
    expect(mockGenerateUniqueProductSlug).not.toHaveBeenCalled();
  });

  it("does not alter a non-empty WooCommerce slug", async () => {
    const event: any = {
      params: { data: { Title: "Source title", Slug: "کیف-دستی" } },
      state: {},
    };

    await productLifecycles.beforeCreate(event);

    expect(event.params.data.Slug).toBe("کیف-دستی");
    expect(mockGenerateUniqueProductSlug).not.toHaveBeenCalled();
  });
});
