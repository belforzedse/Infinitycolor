jest.mock("@/services", () => ({ apiClient: {} }));
import { buildProductEditorPayload } from "../update";
import { buildVariationEditorPayload } from "../variation-editor";
import type { EditProductData } from "@/types/super-admin/products";
import type { ProductVariableDisplay } from "@/components/Product/add/Details/Variable/types";
import type { MediaDataItem } from "../get";

const product: EditProductData = {
  Title: "before",
  Description: "",
  Status: "InActive",
  ProductType: "Simple",
  IsSimpleProduct: true,
  SimpleVariationId: 11,
  SimpleStockId: 12,
  SimpleStockRevision: 4,
  SimpleStock: 7,
  SimpleSKU: "SKU",
  SimplePrice: 100,
  SimpleIsPublished: true,
  CoverImage: null,
  Media: [],
  Files: [],
  product_main_category: null,
  product_tags: [],
  product_other_categories: [],
};
const variation: ProductVariableDisplay = {
  id: 11,
  sku: "SKU",
  price: 100,
  stockId: 12,
  stockRevision: 4,
  stock: 7,
  variable: "S",
  isPublished: true,
};

it("omits volatile stock from a title-only save and strips revision/virtual fields from core data", () => {
  const payload = buildProductEditorPayload(
    { ...product, Title: "after" },
    product,
  );
  expect(payload.simpleVariation).toBeUndefined();
  expect(payload.data).not.toHaveProperty("SimpleStockRevision");
  expect(payload.data).not.toHaveProperty("SimpleStock");
  expect(payload.data.Title).toBe("after");
});

it("combines changed simple stock and size guide with core product data in one body", () => {
  const payload = buildProductEditorPayload(
    { ...product, SimpleStock: 8 },
    product,
    {
      id: 15,
      Helper: [
        ["سایز", "قد"],
        ["M", "50"],
      ],
    },
  );
  expect(payload.simpleVariation?.stock).toEqual({
    id: 12,
    Count: 8,
    expectedStockRevision: 4,
  });
  expect(payload.sizeGuide).toEqual({
    id: 15,
    Helper: [
      ["سایز", "قد"],
      ["M", "50"],
    ],
  });
});

it("uses changed fields and the loaded stock revision for a variation save", () => {
  expect(
    buildVariationEditorPayload({ ...variation, price: 120 }, variation),
  ).toEqual({ data: { Price: 120 } });
  expect(
    buildVariationEditorPayload({ ...variation, stock: 9 }, variation),
  ).toEqual({
    data: {},
    stock: { id: 12, Count: 9, expectedStockRevision: 4 },
  });
});

it("sends ordered image IDs without changing price or stock", () => {
  const draft: EditProductData = {
    ...product,
    ColorGalleries: [
      {
        id: 7,
        color: 2,
        Images: [
          {
            id: 20,
            attributes: { url: "/pink-model.jpg" },
          } as MediaDataItem,
          {
            id: 10,
            attributes: { url: "/pink-product.jpg" },
          } as MediaDataItem,
        ],
      },
    ],
  };

  const payload = buildProductEditorPayload(draft, product);

  expect(payload.data.ColorGalleries).toEqual([
    { id: 7, color: 2, Images: [20, 10] },
  ]);

  expect(payload.simpleVariation).toBeUndefined();
  expect(payload.data).not.toHaveProperty("SimplePrice");
  expect(payload.data).not.toHaveProperty("SimpleStock");
});

it("sends an empty list when all color galleries are cleared", () => {
  const payload = buildProductEditorPayload(
    { ...product, ColorGalleries: [] },
    product,
  );

  expect(payload.data.ColorGalleries).toEqual([]);
});
