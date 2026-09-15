/**
 * The «تصویر شاخص» box used to latch its preview into local state: the sync effect
 * only ever *set* it and never cleared it, so opening a product whose CoverImage is
 * null kept showing the previously opened product's image (content-team report,
 * 2026-09-14). The preview is now derived from the atom on every render.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { editProductDataAtom } from "@/atoms/super-admin/products";
import type { EditProductData } from "@/types/super-admin/products";
import IndexPhotoUploader from "../IndexPhotoUploader";

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ fill: _fill, priority: _priority, ...props }: Record<string, unknown>) => (
    // eslint-disable-next-line @next/next/no-img-element -- a stub for next/image in jsdom
    <img alt="" {...props} />
  ),
}));

const baseProduct: EditProductData = {
  Title: "",
  CoverImage: null,
  Description: "",
  Status: "InActive",
  ProductType: "Variable",
  IsSimpleProduct: false,
  Weight: 100,
  Media: [],
  product_main_category: null,
  product_tags: [],
  Files: [],
  product_other_categories: [],
} as unknown as EditProductData;

const productWithCover = (title: string, url: string): EditProductData =>
  ({
    ...baseProduct,
    Title: title,
    CoverImage: {
      data: {
        id: 101,
        attributes: { url, mime: "image/webp" },
      },
    },
  }) as unknown as EditProductData;

const productWithoutCover = (title: string): EditProductData =>
  ({ ...baseProduct, Title: title, CoverImage: { data: null } }) as unknown as EditProductData;

const renderUploader = (initial: EditProductData) => {
  const store = createStore();
  store.set(editProductDataAtom, initial);
  const view = render(
    <Provider store={store}>
      <IndexPhotoUploader isEditMode />
    </Provider>,
  );
  return { store, ...view };
};

describe("IndexPhotoUploader featured image", () => {
  it("drops the previous product's image when a product without a cover is loaded", () => {
    const { store } = renderUploader(productWithCover("محصول اول", "/uploads/first.webp"));

    expect(screen.getByAltText("Preview")).toBeInTheDocument();
    expect(screen.getByText("آپلود شد")).toBeInTheDocument();

    act(() => {
      store.set(editProductDataAtom, productWithoutCover("محصول دوم"));
    });

    expect(screen.queryByAltText("Preview")).not.toBeInTheDocument();
    expect(screen.queryByText("آپلود شد")).not.toBeInTheDocument();
  });

  it("keeps showing the cover of whichever product is currently in the atom", () => {
    const { store } = renderUploader(productWithCover("محصول اول", "/uploads/first.webp"));

    expect(screen.getByAltText("Preview")).toHaveAttribute(
      "src",
      expect.stringContaining("first.webp"),
    );

    act(() => {
      store.set(editProductDataAtom, productWithCover("محصول دوم", "/uploads/second.webp"));
    });

    expect(screen.getByAltText("Preview")).toHaveAttribute(
      "src",
      expect.stringContaining("second.webp"),
    );
  });

  it("clears the cover without writing back a stale product snapshot", () => {
    const { store } = renderUploader(productWithCover("محصول اول", "/uploads/first.webp"));

    // The product is swapped underneath the component (a product switch, or the edit
    // page's initial fetch landing) before the operator clicks delete.
    act(() => {
      store.set(editProductDataAtom, productWithCover("محصول دوم", "/uploads/second.webp"));
    });

    fireEvent.click(screen.getByTestId("index-photo-delete"));

    const saved = store.get(editProductDataAtom);
    expect(saved.CoverImage).toEqual({ data: null });
    expect(saved.Title).toBe("محصول دوم");
    expect(screen.queryByAltText("Preview")).not.toBeInTheDocument();
  });

  it("does not accept interaction while the product is still loading", () => {
    const store = createStore();
    store.set(editProductDataAtom, productWithCover("محصول اول", "/uploads/first.webp"));
    render(
      <Provider store={store}>
        <IndexPhotoUploader isEditMode disabled />
      </Provider>,
    );

    // The atom still holds the previously opened product until this one's fetch lands.
    expect(screen.queryByAltText("Preview")).not.toBeInTheDocument();
    expect(screen.getByTestId("index-photo-delete")).toBeDisabled();
    expect(screen.getByTestId("index-photo-edit")).toBeDisabled();
    expect(screen.getByTestId("index-photo-upload")).toBeDisabled();

    fireEvent.click(screen.getByTestId("index-photo-delete"));
    expect(store.get(editProductDataAtom).CoverImage).not.toEqual({ data: null });
  });
});
