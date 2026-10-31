/**
 * «انتخاب از کتابخانه» on the gallery appends already-uploaded files to `Media`.
 * Edit mode stores `{ id, attributes }` and relies on the uploader reconciling by URL;
 * add mode stores string ids and removes by position, so the local list and `Media`
 * must stay aligned.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore, useAtomValue } from "jotai";
import { editProductDataAtom, productDataAtom } from "@/atoms/super-admin/products";
import type { EditProductData } from "@/types/super-admin/products";
import PhotoUploader from "../PhotoUploader";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import { listMediaLibrary, type MediaLibraryItem } from "@/services/super-admin/files/mediaLibrary";

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ fill: _fill, loader: _loader, ...props }: Record<string, unknown>) => (
    // eslint-disable-next-line @next/next/no-img-element -- a stub for next/image in jsdom
    <img alt="" {...props} />
  ),
}));

jest.mock("@/hooks/useCan", () => ({
  useCan: (capability: string) => capability === "product.media.manage",
}));

jest.mock("@/services/super-admin/files/mediaLibrary", () => ({
  ...jest.requireActual("@/services/super-admin/files/mediaLibrary"),
  listMediaLibrary: jest.fn(),
}));

const mockListMediaLibrary = listMediaLibrary as jest.MockedFunction<typeof listMediaLibrary>;

const libraryItem = (id: number): MediaLibraryItem => ({
  id,
  name: `file-${id}.webp`,
  alternativeText: null,
  url: `/uploads/file-${id}.webp`,
  mime: "image/webp",
  ext: ".webp",
  width: 800,
  height: 1000,
  size: 20,
  createdAt: "2026-09-20T10:00:00.000Z",
  formats: null,
  thumbnailUrl: `/uploads/file-${id}.webp`,
  video: null,
  usage: { productCount: 0, removedProductCount: 0, usedAsCover: false, products: [] },
});

function libraryResponse(items: MediaLibraryItem[]) {
  return {
    data: items,
    meta: { pagination: { page: 1, pageSize: 24, pageCount: 1, total: items.length } },
  };
}

/** Mirrors `Overall`: edit mode feeds the uploader the saved Media URLs. */
function EditGallery() {
  const product = useAtomValue(editProductDataAtom);
  const images = product.Media.filter((media) => media.attributes.mime?.startsWith("image/")).map(
    (media) => resolveAssetUrl(media.attributes.url),
  );
  return <PhotoUploader initialImages={images} isEditMode />;
}

async function pickFromLibrary(ids: number[]) {
  fireEvent.click(screen.getByTestId("gallery-library-open"));
  await waitFor(() => expect(screen.getAllByTestId("media-library-tile").length).toBeGreaterThan(0));
  for (const id of ids) {
    const tile = screen
      .getAllByTestId("media-library-tile")
      .find((element) => element.getAttribute("data-file-id") === String(id));
    fireEvent.click(tile!);
  }
  fireEvent.click(screen.getByTestId("media-library-confirm"));
}

describe("PhotoUploader media library", () => {
  beforeEach(() => {
    mockListMediaLibrary.mockReset();
  });

  it("shows only this product's uploaded images in its product tab", async () => {
    mockListMediaLibrary.mockResolvedValue(libraryResponse([libraryItem(20), libraryItem(2), libraryItem(1)]));
    const store = createStore();
    store.set(editProductDataAtom, {
      Title: "محصول", CoverImage: null,
      Media: Array.from({ length: 9 }, (_, index) => index + 1).map((id) => ({ id, attributes: { name: `file-${id}.webp`, url: `/uploads/file-${id}.webp`, mime: "image/webp" } })),
      Files: [],
    } as unknown as EditProductData);
    render(<Provider store={store}><EditGallery /></Provider>);
    fireEvent.click(screen.getByTestId("gallery-library-open"));
    await waitFor(() => expect(screen.getAllByTestId("media-library-tile")).toHaveLength(3));
    fireEvent.click(screen.getByRole("tab", { name: /تصاویر این محصول/ }));
    expect(screen.getAllByTestId("media-library-tile").map((tile) => tile.getAttribute("data-file-id"))).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(screen.getAllByTestId("media-library-tile").every((tile) => tile.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(screen.queryByText("روی تصاویر کلیک کنید تا انتخاب شوند")).not.toBeInTheDocument();
  });

  it("appends only new files to a saved product's gallery", async () => {
    mockListMediaLibrary.mockResolvedValue(
      libraryResponse([libraryItem(3), libraryItem(2), libraryItem(1)]),
    );
    const store = createStore();
    store.set(editProductDataAtom, {
      Title: "محصول",
      CoverImage: null,
      Media: [{ id: 1, attributes: { url: "/uploads/file-1.webp", mime: "image/webp" } }],
      Files: [],
    } as unknown as EditProductData);
    render(
      <Provider store={store}>
        <EditGallery />
      </Provider>,
    );
    expect(screen.getAllByAltText(/Uploaded image/)).toHaveLength(1);

    fireEvent.click(screen.getByTestId("gallery-library-open"));
    await waitFor(() => expect(screen.getAllByTestId("media-library-tile")).toHaveLength(3));
    const tile = (id: number) =>
      screen
        .getAllByTestId("media-library-tile")
        .find((element) => element.getAttribute("data-file-id") === String(id))!;
    expect(tile(1)).toHaveAttribute("aria-disabled", "true");

    // Pick order is kept, and the file already in the gallery cannot be picked again.
    fireEvent.click(tile(2));
    fireEvent.click(tile(3));
    fireEvent.click(tile(1));
    fireEvent.click(screen.getByTestId("media-library-confirm"));

    const media = store.get(editProductDataAtom).Media;
    expect(media.map((entry) => entry.id)).toEqual([1, 2, 3]);
    expect(media[1].attributes).toMatchObject({ url: "/uploads/file-2.webp", mime: "image/webp" });
    expect(store.get(editProductDataAtom).Title).toBe("محصول");
    await waitFor(() => expect(screen.getAllByAltText(/Uploaded image/)).toHaveLength(3));
  });

  it("keeps a new product's string ids aligned with the grid for removal", async () => {
    mockListMediaLibrary.mockResolvedValue(libraryResponse([libraryItem(5), libraryItem(6)]));
    const store = createStore();
    render(
      <Provider store={store}>
        <PhotoUploader />
      </Provider>,
    );

    await pickFromLibrary([5, 6]);

    expect(store.get(productDataAtom).Media).toEqual(["5", "6"]);
    expect(screen.getAllByAltText(/Uploaded image/)).toHaveLength(2);
    expect(screen.getByAltText("Uploaded image 2")).toHaveAttribute(
      "src",
      expect.stringContaining("file-6.webp"),
    );

    fireEvent.click(screen.getAllByLabelText("حذف رسانه")[1]);

    expect(store.get(productDataAtom).Media).toEqual(["5"]);
    expect(screen.getAllByAltText(/Uploaded image/)).toHaveLength(1);
  });
});
