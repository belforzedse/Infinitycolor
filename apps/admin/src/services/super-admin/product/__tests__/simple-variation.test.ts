jest.mock("@/services", () => ({ apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn() } }));

import { apiClient } from "@/services";
import { syncSimpleProductVariation } from "../simple-variation";

const get = apiClient.get as jest.Mock;
const post = apiClient.post as jest.Mock;
const put = apiClient.put as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  const serverNow = new Date().toISOString();
  const snapshot = { product: { id: 42, attributes: {} }, revision: 1 };
  get.mockImplementation(async (url: string) => ({ data: url.endsWith("edit-snapshot") ? snapshot : { owner: null, generation: 0 } }));
  post.mockImplementation(async (url: string) => ({ data: url.endsWith("acquire") ? {
    snapshot, lease: { token: "proof", editorInstanceId: "instance", generation: 1, serverNow, expiresAt: new Date(Date.now() + 90_000).toISOString() },
  } : { released: true } }));
  put.mockResolvedValue({ data: {}, meta: { editRevision: 2 } });
});

it("acquires ownership before the atomic simple-product follow-up and releases afterwards", async () => {
  await syncSimpleProductVariation(42, { ProductType: "Simple", SimpleSKU: "SIMPLE-42", SimplePrice: 250_000, SimpleStock: 9 });
  expect(post.mock.calls[0][0]).toBe("/products/42/edit-lease/acquire");
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith("/products/42/editor", {
    data: {}, simpleVariation: { SKU: "SIMPLE-42", Price: 250_000, DiscountPrice: null, IsPublished: true, stock: { Count: 9 } },
  }, expect.objectContaining({ retries: 0, headers: expect.objectContaining({ "X-Product-Expected-Revision": "1" }) }));
  expect(post.mock.calls[1][0]).toBe("/products/42/edit-lease/release");
});

it("does not mutate a newly created product when ownership cannot be acquired", async () => {
  get.mockResolvedValue({ data: { owner: { id: 7, label: "همکار" } } });
  // A real snapshot is required; a failed fresh read is also fail-closed.
  await expect(syncSimpleProductVariation(42, { ProductType: "Simple", SimpleStock: 9 })).rejects.toThrow();
  expect(put).not.toHaveBeenCalled();
});
