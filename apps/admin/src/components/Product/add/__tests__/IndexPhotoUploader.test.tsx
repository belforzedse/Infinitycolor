/**
 * The «تصویر شاخص» box used to latch its preview into local state: the sync effect
 * only ever *set* it and never cleared it, so opening a product whose CoverImage is
 * null kept showing the previously opened product's image (content-team report,
 * 2026-09-14). The preview is now derived from the atom on every render.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { editProductDataAtom } from "@/atoms/super-admin/products";
import type { EditProductData } from "@/types/super-admin/products";
import IndexPhotoUploader from "../IndexPhotoUploader";
import { listMediaLibrary, type MediaLibraryItem } from "@/services/super-admin/files/mediaLibrary";

let mockCapabilities: string[] = [];
jest.mock("@/hooks/useCan", () => ({
  useCan: (capability: string) => mockCapabilities.includes(capability),
}));

jest.mock("@/services/super-admin/files/mediaLibrary", () => ({
  ...jest.requireActual("@/services/super-admin/files/mediaLibrary"),
  listMediaLibrary: jest.fn(),
}));

const mockListMediaLibrary = listMediaLibrary as jest.MockedFunction<typeof listMediaLibrary>;

jest.mock("@/services/super-admin/files/upload", () => ({
  uploadFile: jest.fn(),
}));
// eslint-disable-next-line import/first -- the mock above must be registered first
import { uploadFile } from "@/services/super-admin/files/upload";
const mockUploadFile = uploadFile as jest.MockedFunction<typeof uploadFile>;

const libraryItem = (id: number, url: string): MediaLibraryItem => ({
  id,
  name: `file-${id}.webp`,
  alternativeText: null,
  url,
  mime: "image/webp",
  ext: ".webp",
  width: 800,
  height: 1000,
  size: 20,
  createdAt: "2026-09-20T10:00:00.000Z",
  formats: null,
  thumbnailUrl: url,
  video: null,
  usage: { productCount: 1, removedProductCount: 0, usedAsCover: false, products: [] },
});

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

describe("IndexPhotoUploader media library", () => {
  beforeEach(() => {
    mockCapabilities = [];
    mockListMediaLibrary.mockReset();
  });

  it("offers the library only to roles that manage product media", () => {
    renderUploader(productWithCover("محصول", "/uploads/first.webp"));
    expect(screen.queryByTestId("index-photo-library")).not.toBeInTheDocument();
  });

  it("sets the picked library file as the cover and keeps the rest of the product", async () => {
    mockCapabilities = ["product.media.manage"];
    mockListMediaLibrary.mockResolvedValue({
      data: [libraryItem(202, "/uploads/picked.webp"), libraryItem(101, "/uploads/first.webp")],
      meta: { pagination: { page: 1, pageSize: 24, pageCount: 1, total: 2 } },
    });
    const { store } = renderUploader(productWithCover("محصول اول", "/uploads/first.webp"));

    fireEvent.click(screen.getByTestId("index-photo-library"));
    await waitFor(() => expect(screen.getAllByTestId("media-library-tile")).toHaveLength(2));
    expect(mockListMediaLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, type: "image", usage: "all" }),
    );

    // The current cover is locked; the other file is selectable.
    const [picked, current] = screen.getAllByTestId("media-library-tile");
    expect(current).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(picked);
    fireEvent.click(screen.getByTestId("media-library-confirm"));

    const saved = store.get(editProductDataAtom);
    expect(saved.CoverImage?.data?.id).toBe(202);
    expect(saved.CoverImage?.data?.attributes.url).toBe("/uploads/picked.webp");
    expect(saved.Title).toBe("محصول اول");
    expect(screen.getByAltText("Preview")).toHaveAttribute(
      "src",
      expect.stringContaining("picked.webp"),
    );
    expect(screen.queryByTestId("media-library-confirm")).not.toBeInTheDocument();
  });

  it("replaces a cover uploaded earlier in the session, whose local preview otherwise wins", async () => {
    mockCapabilities = ["product.media.manage"];
    // Resolve after the FileReader, as a real upload does, so the local preview is shown.
    mockUploadFile.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve([{ id: 303, url: "/uploads/uploaded.webp", mime: "image/webp" } as any]),
            50,
          ),
        ),
    );
    mockListMediaLibrary.mockResolvedValue({
      data: [libraryItem(202, "/uploads/picked.webp")],
      meta: { pagination: { page: 1, pageSize: 24, pageCount: 1, total: 1 } },
    });
    const { container, store } = renderUploader(productWithoutCover("محصول"));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "local.webp", { type: "image/webp" })] },
    });
    await waitFor(() => expect(store.get(editProductDataAtom).CoverImage?.data?.id).toBe(303));
    await waitFor(() =>
      expect(screen.getByAltText("Preview").getAttribute("src")).toMatch(/^data:/),
    );

    fireEvent.click(screen.getByTestId("index-photo-library"));
    fireEvent.click(await screen.findByTestId("media-library-tile"));
    fireEvent.click(screen.getByTestId("media-library-confirm"));

    expect(store.get(editProductDataAtom).CoverImage?.data?.id).toBe(202);
    expect(screen.getByAltText("Preview")).toHaveAttribute(
      "src",
      expect.stringContaining("picked.webp"),
    );
  });

  it("keeps the library closed while the product is still loading", () => {
    mockCapabilities = ["product.media.manage"];
    const store = createStore();
    store.set(editProductDataAtom, productWithCover("محصول اول", "/uploads/first.webp"));
    render(
      <Provider store={store}>
        <IndexPhotoUploader isEditMode disabled />
      </Provider>,
    );

    expect(screen.getByTestId("index-photo-library")).toBeDisabled();
  });
});
