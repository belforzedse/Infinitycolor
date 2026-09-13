jest.mock("@/services", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
}));

import { apiClient } from "@/services";
import { syncSimpleProductVariation } from "../simple-variation";

const mockGet = apiClient.get as jest.Mock;
const mockPost = apiClient.post as jest.Mock;
const mockPut = apiClient.put as jest.Mock;

describe("simple product variation synchronization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ data: [{ id: 17 }] });
    mockPost.mockResolvedValue({ data: { id: 17 } });
    mockPut.mockResolvedValue({ data: { id: 17 } });
  });

  it("does not resend the protected product relation when updating an existing variation", async () => {
    await syncSimpleProductVariation(42, {
      ProductType: "Simple",
      SimpleVariationId: 17,
      SimpleStockId: 23,
      SimpleSKU: "SIMPLE-42",
      SimplePrice: 250_000,
      SimpleDiscountPrice: 225_000,
      SimpleStock: 9,
      SimpleIsPublished: true,
    });

    expect(mockPut).toHaveBeenNthCalledWith(1, "/product-variations/17", {
      data: {
        SKU: "SIMPLE-42",
        Price: 250_000,
        DiscountPrice: 225_000,
        IsPublished: true,
      },
    });
    expect(mockPut).toHaveBeenNthCalledWith(2, "/product-stocks/23", {
      data: { Count: 9 },
    });
  });

  it("includes the product relation when creating the synthetic variation", async () => {
    await syncSimpleProductVariation(42, {
      ProductType: "Simple",
      SimpleSKU: "SIMPLE-42",
      SimplePrice: 250_000,
      SimpleStock: 9,
    });

    expect(mockPost).toHaveBeenNthCalledWith(1, "/product-variations", {
      data: {
        product: 42,
        SKU: "SIMPLE-42",
        Price: 250_000,
        DiscountPrice: null,
        IsPublished: true,
      },
    });
    expect(mockPost).toHaveBeenNthCalledWith(2, "/product-stocks", {
      data: { Count: 9, product_variation: 17 },
    });
  });
});
