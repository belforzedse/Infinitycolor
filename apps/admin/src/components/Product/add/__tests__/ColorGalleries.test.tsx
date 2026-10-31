import { fireEvent, render, screen, within } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import ProductColorGalleries from "../PhotoUploader/ProductColorGalleries";
import { editProductDataAtom } from "@/atoms/super-admin/products";
import {
  toMediaDataItem,
  type MediaLibraryItem,
} from "@/services/super-admin/files/mediaLibrary";
import { transformToProductData } from "@/utils/populatedProductData";
import { buildProductEditorPayload } from "@/services/super-admin/product/update";
import type { ProductDataResponse } from "@/services/super-admin/product/get";

let mockCanEdit = true;
let mockCanManageMedia = true;
let mockPicked: MediaLibraryItem[] = [];
jest.mock("@/services", () => ({ apiClient: {} }));
jest.mock("@/hooks/useCan", () => ({
  useCan: (capability: string) =>
    capability !== "product.media.manage" || mockCanManageMedia,
}));
jest.mock("@/hooks/product/ProductEditorContext", () => ({
  useProductEditor: () => ({ canEdit: mockCanEdit, state: { busy: false } }),
}));
jest.mock(
  "@/components/MediaLibrary/MediaLibraryModal",
  () =>
    function MockMediaLibraryModal({ isOpen, onConfirm }: any) {
      return isOpen ? (
        <button onClick={() => onConfirm(mockPicked)}>confirm library</button>
      ) : null;
    },
);

jest.mock(
  "../PhotoUploader/ImageGrid",
  () =>
    function MockImageGrid({ items, onRemoveFile, onReorder }: any) {
      return (
        <div>
          <output>{items.map((item: any) => item.fileId).join(",")}</output>
          <button type="button" onClick={() => onRemoveFile(0)}>
            remove first photo
          </button>
          <button type="button" onClick={() => onReorder?.(0, 1)}>
            reorder photos
          </button>
        </div>
      );
    },
);

const item = (id: number): MediaLibraryItem => ({
  id,
  name: "photo-" + id,
  alternativeText: null,
  url: "/uploads/photo-" + id + ".jpg",
  mime: "image/jpeg",
  ext: ".jpg",
  width: 800,
  height: 1000,
  size: 1,
  createdAt: "2026-01-01",
  formats: null,
  thumbnailUrl: null,
  video: null,
  usage: {
    productCount: 0,
    removedProductCount: 0,
    usedAsCover: false,
    products: [],
  },
});
const response = (): ProductDataResponse =>
  ({
    Title: "fixture",
    Description: "",
    Status: "InActive",
    ProductType: "Variable",
    product_variations: { data: [] },
    CoverImage: { data: null },
    Media: { data: [toMediaDataItem(item(99))] },
    ColorGalleries: [
      {
        id: 7,
        color: { data: { id: 1 } },
        Images: { data: [toMediaDataItem(item(10))] },
      },
    ],
  }) as ProductDataResponse;
const colors = [
  { id: 1, title: "قرمز" },
  { id: 1, title: "قرمز" },
  { id: 2, title: "آبی" },
];
const section = (title: string) =>
  within(
    screen
      .getByRole("heading", { name: "تصاویر " + title })
      .closest("section")!,
  );

beforeEach(() => {
  mockCanEdit = true;
  mockCanManageMedia = true;
  mockPicked = [];
});

it("keeps repeated picks for the same color in a single unsaved draft", () => {
  const store = createStore();
  const base = transformToProductData(response());
  store.set(editProductDataAtom, base);
  render(<Provider store={store}><ProductColorGalleries colors={colors} /></Provider>);
  for (const id of [20, 21, 22]) {
    mockPicked = [item(id)];
    fireEvent.click(section("قرمز").getByRole("button", { name: "انتخاب یا آپلود تصویر" }));
    fireEvent.click(section("قرمز").getByText("confirm library"));
  }
  expect(buildProductEditorPayload(store.get(editProductDataAtom), base).data.ColorGalleries)
    .toEqual([{ id: 7, color: 1, Images: [10, 20, 21, 22] }]);
});

it("loads one gallery per color, assigns/reorders/removes images independently and preserves the saved component id", () => {
  const store = createStore();
  const base = transformToProductData(response());
  store.set(editProductDataAtom, base);
  render(
    <Provider store={store}>
      <ProductColorGalleries colors={colors} />
    </Provider>,
  );
  expect(screen.getAllByRole("heading", { name: "تصاویر قرمز" })).toHaveLength(
    1,
  );
  mockPicked = [item(20)];
  fireEvent.click(
    section("قرمز").getByRole("button", { name: "انتخاب یا آپلود تصویر" }),
  );
  fireEvent.click(section("قرمز").getByText("confirm library"));
  fireEvent.click(section("قرمز").getByText("reorder photos"));
  mockPicked = [item(30)];
  fireEvent.click(
    section("آبی").getByRole("button", { name: "انتخاب یا آپلود تصویر" }),
  );
  fireEvent.click(section("آبی").getByText("confirm library"));
  let payload = buildProductEditorPayload(store.get(editProductDataAtom), base);
  expect(payload.data.ColorGalleries).toEqual([
    { id: 7, color: 1, Images: [20, 10] },
    { color: 2, Images: [30] },
  ]);
  fireEvent.click(section("قرمز").getByText("remove first photo"));
  payload = buildProductEditorPayload(store.get(editProductDataAtom), base);
  expect(payload.data.ColorGalleries?.[0]).toEqual({
    id: 7,
    color: 1,
    Images: [10],
  });
  expect(payload.data.ColorGalleries?.[1].Images).toEqual([30]);
  expect(store.get(editProductDataAtom).Media).toEqual(base.Media);
});

it("blocks changes and closes the media picker when the edit lease is lost", () => {
  const store = createStore();
  const base = transformToProductData(response());
  store.set(editProductDataAtom, base);
  const view = (
    <Provider store={store}>
      <ProductColorGalleries colors={colors} />
    </Provider>
  );
  const { rerender } = render(view);
  fireEvent.click(
    section("قرمز").getByRole("button", { name: "انتخاب یا آپلود تصویر" }),
  );
  mockCanEdit = false;
  rerender(
    <Provider store={store}>
      <ProductColorGalleries colors={[...colors]} />
    </Provider>,
  );
  expect(screen.queryByText("confirm library")).not.toBeInTheDocument();
  expect(
    section("قرمز").getByRole("button", { name: "انتخاب یا آپلود تصویر" }),
  ).toBeDisabled();
  expect(section("قرمز").getByText("remove first photo")).toBeDisabled();
  expect(store.get(editProductDataAtom)).toEqual(base);
});

it("respects the existing media permission", () => {
  mockCanManageMedia = false;
  const store = createStore();
  store.set(editProductDataAtom, transformToProductData(response()));
  render(
    <Provider store={store}>
      <ProductColorGalleries colors={colors} />
    </Provider>,
  );
  expect(
    section("قرمز").getByRole("button", { name: "انتخاب یا آپلود تصویر" }),
  ).toBeDisabled();
  expect(section("قرمز").getByText("reorder photos")).toBeDisabled();
});

it("preserves mapping on a title-only save and supports products without a mapping", () => {
  const base = transformToProductData(response());
  expect(
    buildProductEditorPayload({ ...base, Title: "changed" }, base).data
      .ColorGalleries,
  ).toBeUndefined();
  const legacy = response();
  delete legacy.ColorGalleries;
  const draft = transformToProductData(legacy);
  expect(draft.ColorGalleries).toBeUndefined();
  expect(
    JSON.parse(JSON.stringify(buildProductEditorPayload(draft, draft))).data,
  ).not.toHaveProperty("ColorGalleries");
});
