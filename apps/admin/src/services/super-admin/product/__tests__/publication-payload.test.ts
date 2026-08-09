jest.mock("@/services", () => ({
  apiClient: { post: jest.fn(), put: jest.fn() },
}));

jest.mock("react-hot-toast", () => ({
  toast: { error: jest.fn() },
}));

jest.mock("../simple-variation", () => ({
  syncSimpleProductVariation: jest.fn(),
}));

import { apiClient } from "@/services";
import type {
  EditProductData,
  ProductData,
} from "@/types/super-admin/products";
import { createProduct } from "../create";
import { updateProduct } from "../update";

const mockPost = apiClient.post as jest.Mock;
const mockPut = apiClient.put as jest.Mock;

const draftProduct: ProductData = {
  Title: "Publication boundary regression",
  CoverImage: null,
  Description: "Synthetic test product",
  Status: "Active",
  ProductType: "Variable",
  IsSimpleProduct: false,
  Media: [],
  product_main_category: null,
  product_tags: [],
  Files: [],
  product_other_categories: [],
};

describe("admin product publication payload boundary", () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPut.mockReset();
  });

  it("does not send Status through generic product creation", async () => {
    mockPost.mockResolvedValue({ data: { id: 42 } });

    await createProduct(draftProduct);

    const [, payload] = mockPost.mock.calls[0];
    expect(payload.data).not.toHaveProperty("Status");
  });

  it("does not send publication state through generic product updates", async () => {
    mockPut.mockResolvedValue({ data: { id: 42 } });
    const editProduct: EditProductData = {
      ...draftProduct,
      scheduledPublishAt: "2026-08-10T10:00:00.000Z",
      scheduledPublishTimezone: "Asia/Tehran",
      scheduledPublishLastAttemptAt: "2026-08-09T10:00:00.000Z",
      scheduledPublishLastError: "synthetic",
      scheduledPublishFailureKind: "Transient",
    };

    await updateProduct("42", editProduct);

    const [, payload] = mockPut.mock.calls[0];
    expect(payload.data).not.toHaveProperty("Status");
    expect(payload.data).not.toHaveProperty("scheduledPublishAt");
    expect(payload.data).not.toHaveProperty("scheduledPublishTimezone");
    expect(payload.data).not.toHaveProperty("scheduledPublishLastAttemptAt");
    expect(payload.data).not.toHaveProperty("scheduledPublishLastError");
    expect(payload.data).not.toHaveProperty("scheduledPublishFailureKind");
  });
});
