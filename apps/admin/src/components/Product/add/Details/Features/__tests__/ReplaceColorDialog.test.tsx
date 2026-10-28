import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockReplaceProductColor = jest.fn();
jest.mock("@/services/product/variation-color-replace", () => ({
  replaceProductColor: (...args: unknown[]) => mockReplaceProductColor(...args),
}));
jest.mock("@/services/product/variation-options", () => ({
  searchColors: jest.fn().mockResolvedValue([
    { id: "1", title: "قرمز", colorCode: "#ff0000" },
    { id: "2", title: "آبی", colorCode: "#0000ff" },
  ]),
}));
let mockCapabilities = new Set<string>(["product.variation.delete"]);
jest.mock("@/hooks/useCan", () => ({
  useCan: (capability: string) => mockCapabilities.has(capability),
}));
jest.mock("@/lib/api-cache", () => ({ apiCache: { clearByPattern: jest.fn() } }));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

import ReplaceColorDialog from "../ReplaceColorDialog";

const RED = { id: "1", value: "قرمز", colorCode: "#ff0000" };

const preview = (overrides: Record<string, unknown> = {}) => ({
  productId: 5,
  dryRun: true,
  fromColor: { id: 1, title: "قرمز" },
  targetColor: { id: 2, title: "آبی", colorCode: "#0000ff", created: false },
  moving: [
    { id: 11, label: "S", sku: "A", isPublished: true },
    { id: 12, label: "M", sku: "B", isPublished: true },
  ],
  emptyDrafts: [],
  blocking: [],
  ...overrides,
});

function renderDialog() {
  const onClose = jest.fn();
  const onReplaced = jest.fn();
  render(
    <ReplaceColorDialog productId={5} color={RED} onClose={onClose} onReplaced={onReplaced} />,
  );
  return { onClose, onReplaced };
}

async function pickBlue() {
  await userEvent.type(screen.getByPlaceholderText("جستجوی نام یا کد رنگ..."), "آ");
  await userEvent.click(await screen.findByText("آبی"));
}

const applyButton = () => screen.getByRole("button", { name: "اعمال روی این محصول" });

describe("ReplaceColorDialog", () => {
  beforeEach(() => {
    mockReplaceProductColor.mockReset();
    mockCapabilities = new Set(["product.variation.delete"]);
  });

  it("previews the move before applying it to this product only", async () => {
    mockReplaceProductColor
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce(preview({ dryRun: false }));
    const { onClose, onReplaced } = renderDialog();

    expect(applyButton()).toBeDisabled();
    await pickBlue();

    expect(mockReplaceProductColor).toHaveBeenNthCalledWith(1, 5, 1, { toColorId: 2 }, { dryRun: true }, expect.anything());
    expect(await screen.findByText(/2 تنوع به رنگ «آبی» منتقل می‌شود/)).toBeInTheDocument();

    await userEvent.click(applyButton());

    await waitFor(() =>
      expect(mockReplaceProductColor).toHaveBeenNthCalledWith(2, 5, 1, { toColorId: 2 }, {
        removeEmptyDrafts: false,
      }, expect.anything()),
    );
    expect(onReplaced).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the empty drafts it will remove and confirms their removal on apply", async () => {
    const drafts = [{ id: 14, label: "S", sku: "GEN", isPublished: false }];
    mockReplaceProductColor
      .mockResolvedValueOnce(preview({ emptyDrafts: drafts }))
      .mockResolvedValueOnce(preview({ dryRun: false, emptyDrafts: drafts }));
    renderDialog();

    await pickBlue();
    expect(await screen.findByText(/تنوع پیش‌نویسِ خالی/)).toBeInTheDocument();

    await userEvent.click(applyButton());
    await waitFor(() =>
      expect(mockReplaceProductColor).toHaveBeenLastCalledWith(5, 1, { toColorId: 2 }, {
        removeEmptyDrafts: true,
      }, expect.anything()),
    );
  });

  it("will not remove drafts for someone who cannot delete variations", async () => {
    mockCapabilities = new Set();
    mockReplaceProductColor.mockResolvedValueOnce(
      preview({ emptyDrafts: [{ id: 14, label: "S", sku: "GEN", isPublished: false }] }),
    );
    renderDialog();

    await pickBlue();
    expect(await screen.findByText(/مجوز حذف تنوع را ندارید/)).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
  });

  it("blocks when a real variation already has the new colour", async () => {
    mockReplaceProductColor.mockResolvedValueOnce(
      preview({
        blocking: [{ id: 14, label: "S", sku: "X", isPublished: true, movingId: 11, reason: "occupied" }],
      }),
    );
    renderDialog();

    await pickBlue();
    expect(await screen.findByText(/از قبل وجود دارند/)).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
  });

  it("offers a new colour prefilled with the current one so only the hex needs fixing", async () => {
    mockReplaceProductColor.mockResolvedValueOnce(
      preview({ targetColor: { id: null, title: "قرمز", colorCode: "#e0115f", created: true } }),
    );
    renderDialog();

    await userEvent.click(screen.getByRole("tab", { name: "رنگ جدید با کد دیگر" }));
    expect(screen.getByLabelText("نام رنگ")).toHaveValue("قرمز");
    const hex = screen.getByLabelText("کد رنگ");
    expect(hex).toHaveValue("#ff0000");

    await userEvent.clear(hex);
    await userEvent.type(hex, "e0115f");
    await userEvent.click(screen.getByRole("button", { name: "بررسی تغییر" }));

    await waitFor(() =>
      expect(mockReplaceProductColor).toHaveBeenCalledWith(
        5,
        1,
        { newColor: { title: "قرمز", colorCode: "#e0115f" } },
        { dryRun: true },
        expect.anything(),
      ),
    );
    expect(await screen.findByText("رنگ «قرمز» به فهرست رنگ‌ها افزوده می‌شود.")).toBeInTheDocument();
    expect(applyButton()).toBeEnabled();
  });
});
