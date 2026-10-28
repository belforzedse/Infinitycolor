jest.mock("@/services", () => ({ apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn() } }));
jest.mock("../get", () => ({ getProduct: jest.fn() }));
jest.mock("react-hot-toast", () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

import { apiClient } from "@/services";
import { getProduct } from "../get";
import { duplicateProduct } from "../duplicate";

const get = apiClient.get as jest.Mock;
const post = apiClient.post as jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  (getProduct as jest.Mock).mockResolvedValue({ data: { id: 42, attributes: { Title: "original", ProductType: "Variable", product_variations: { data: [{ id: 11 }] } } } });
  get.mockImplementation(async (url: string) => ({ data: url.endsWith("edit-snapshot")
    ? { product: { id: 99, attributes: { Title: "copy" } }, revision: 1 }
    : url.endsWith("edit-lease") ? { owner: null, generation: 0 }
      : url.startsWith("/product-attribute-assignments") ? []
        : { id: 11, attributes: { SKU: "SKU", Price: 100, product_stock: { data: { id: 12, attributes: { Count: 7 } } } } } }));
  post.mockImplementation(async (url: string) => ({ data: url.endsWith("acquire") ? {
    snapshot: { product: { id: 99, attributes: { Title: "copy" } }, revision: 1 },
    lease: { token: "ephemeral-proof", editorInstanceId: "new-copy-instance", generation: 1, expiresAt: new Date(Date.now() + 90_000).toISOString(), serverNow: new Date().toISOString() },
  } : { id: url === "/products" ? 99 : 22, released: true }, meta: { editRevision: url === "/product-stocks" ? 3 : 2 } }));
});

it("acquires the new product before copying child rows and releases the proof afterwards", async () => {
  const result = await duplicateProduct("42");
  expect(result).toMatchObject({ success: true, newProductId: 99, failedVariationCount: 0 });
  expect(post.mock.calls.map(([url]) => url)).toEqual(["/products", "/products/99/edit-lease/acquire", "/product-variations", "/product-stocks", "/products/99/edit-lease/release"]);
  expect(post.mock.calls[2][2]).toMatchObject({ retries: 0, headers: { "X-Product-Edit-Token": "ephemeral-proof", "X-Product-Expected-Revision": "1" } });
  expect(post.mock.calls[3][1].data.Count).toBe(0);
  expect(post.mock.calls[3][2].headers["X-Product-Expected-Revision"]).toBe("2");
});

it("keeps a created copy navigable without attempting child writes when acquisition fails", async () => {
  get.mockImplementation(async (url: string) => ({ data: url.endsWith("edit-snapshot") ? { product: { id: 99, attributes: {} }, revision: 1 } : { owner: { id: 2, label: "همکار" } } }));
  const result = await duplicateProduct("42");
  expect(result).toMatchObject({ success: true, newProductId: 99, followupFailed: true });
  expect(post.mock.calls.map(([url]) => url)).toEqual(["/products"]);
});
