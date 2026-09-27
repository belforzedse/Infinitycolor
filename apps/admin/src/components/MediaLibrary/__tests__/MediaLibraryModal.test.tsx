import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import MediaLibraryModal from "../MediaLibraryModal";
import { listMediaLibrary, type MediaLibraryItem } from "@/services/super-admin/files/mediaLibrary";

jest.mock("use-debounce", () => ({
  useDebouncedCallback: (callback: (...args: any[]) => void) => {
    const debounced = (...args: any[]) => callback(...args);
    debounced.cancel = jest.fn();
    return debounced;
  },
}));

jest.mock("@/services/super-admin/files/mediaLibrary", () => ({
  ...jest.requireActual("@/services/super-admin/files/mediaLibrary"),
  listMediaLibrary: jest.fn(),
}));

const mockList = listMediaLibrary as jest.MockedFunction<typeof listMediaLibrary>;

const item = (id: number, overrides: Partial<MediaLibraryItem> = {}): MediaLibraryItem => ({
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
  usage: {
    productCount: 2,
    removedProductCount: 0,
    usedAsCover: true,
    products: [
      { id: 10, title: "مانتو", removed: false, asCover: true },
      { id: 11, title: "شومیز", removed: false, asCover: false },
    ],
  },
  ...overrides,
});

const page = (items: MediaLibraryItem[], total = items.length, pageNumber = 1) => ({
  data: items,
  meta: { pagination: { page: pageNumber, pageSize: 24, pageCount: 1, total } },
});

function renderModal(props: Partial<React.ComponentProps<typeof MediaLibraryModal>> = {}) {
  const onConfirm = jest.fn();
  const onClose = jest.fn();
  render(
    <MediaLibraryModal
      isOpen
      onClose={onClose}
      title="کتابخانه"
      selection="multiple"
      allowedTypes={["image"]}
      confirmLabel={(count) => `افزودن ${count}`}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm, onClose };
}

const tiles = () => screen.getAllByTestId("media-library-tile");

describe("MediaLibraryModal", () => {
  beforeEach(() => {
    mockList.mockReset();
  });

  it("lists catalog files with their product usage", async () => {
    mockList.mockResolvedValue(page([item(1)]));
    renderModal();

    await waitFor(() => expect(tiles()).toHaveLength(1));
    const badge = screen.getByText("در ۲ محصول");
    expect(badge).toHaveAttribute("title", expect.stringContaining("مانتو (کاور)"));
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, type: "image", usage: "all", search: "" }),
    );
  });

  it("searches and filters on the server", async () => {
    mockList.mockResolvedValue(page([item(1)]));
    renderModal({ allowedTypes: ["image", "video"], selection: "single" });
    await waitFor(() => expect(tiles()).toHaveLength(1));

    fireEvent.change(screen.getByTestId("media-library-search"), { target: { value: " W00288 " } });
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ search: "W00288" })),
    );

    fireEvent.click(screen.getByRole("button", { name: "ویدیو" }));
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ type: "video" })),
    );

    fireEvent.click(screen.getByRole("button", { name: "بدون اتصال" }));
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ usage: "unattached" })),
    );
  });

  it("loads more pages until everything is shown", async () => {
    mockList
      .mockResolvedValueOnce(page([item(1), item(2)], 3))
      .mockResolvedValueOnce(page([item(3)], 3, 2));
    renderModal();
    await waitFor(() => expect(tiles()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: /نمایش بیشتر/ }));

    await waitFor(() => expect(tiles()).toHaveLength(3));
    expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    expect(screen.queryByRole("button", { name: /نمایش بیشتر/ })).not.toBeInTheDocument();
  });

  it("confirms picks in order, skips locked files and respects the limit", async () => {
    mockList.mockResolvedValue(page([item(1), item(2), item(3), item(4)]));
    const { onConfirm } = renderModal({ lockedIds: new Set([4]), maxSelection: 2 });
    await waitFor(() => expect(tiles()).toHaveLength(4));

    fireEvent.click(tiles()[1]);
    fireEvent.click(tiles()[0]);
    fireEvent.click(tiles()[2]); // over the limit
    fireEvent.click(tiles()[3]); // locked
    expect(tiles()[1]).toHaveAttribute("aria-checked", "true");
    expect(tiles()[2]).toHaveAttribute("aria-checked", "false");
    expect(tiles()[3]).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(screen.getByTestId("media-library-confirm"));

    expect(onConfirm).toHaveBeenCalledWith([
      expect.objectContaining({ id: 2 }),
      expect.objectContaining({ id: 1 }),
    ]);
  });

  it("confirms a single pick on double click and never offers a failed video", async () => {
    mockList.mockResolvedValue(
      page([item(1), item(2, { mime: "video/mp4", video: { status: "failed", posterUrl: null } })]),
    );
    const { onConfirm } = renderModal({ selection: "single", allowedTypes: ["image", "video"] });
    await waitFor(() => expect(tiles()).toHaveLength(2));

    expect(tiles()[1]).toHaveAttribute("aria-disabled", "true");
    fireEvent.doubleClick(tiles()[1]);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.doubleClick(tiles()[0]);
    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ id: 1 })]);
  });

  it("offers this product's own images in a separate tab", async () => {
    mockList.mockResolvedValue(page([item(1)]));
    renderModal({ ownMedia: [item(7), item(8)], selection: "single" });
    await waitFor(() => expect(tiles()).toHaveLength(1));

    fireEvent.click(screen.getByRole("tab", { name: /تصاویر این محصول/ }));

    expect(tiles().map((tile) => tile.getAttribute("data-file-id"))).toEqual(["7", "8"]);
  });

  it("shows an error with a retry", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockList.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(page([item(1)]));
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: /تلاش مجدد/ }));

    await waitFor(() => expect(tiles()).toHaveLength(1));
  });
});
