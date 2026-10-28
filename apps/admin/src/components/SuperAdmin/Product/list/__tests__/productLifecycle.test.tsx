import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";

jest.mock("@/services/super-admin/product/lifecycle", () => ({
  moveProductToTrash: jest.fn(),
  restoreProductFromTrash: jest.fn(),
  permanentlyDeleteProduct: jest.fn(),
  runBulkProductLifecycle: jest.fn(),
  emptyProductTrash: jest.fn(),
  createProductPreviewLink: jest.fn(),
}));
jest.mock("@/services/super-admin/product/publication", () => ({
  PRODUCT_PUBLICATION_TIMEZONE: "Asia/Tehran",
  changeProductPublication: jest.fn(),
}));
jest.mock("@/services/super-admin/product/duplicate", () => ({ duplicateProduct: jest.fn() }));
const mockShowUndoToast = jest.fn();
jest.mock("../undoToast", () => ({ showUndoToast: (...args: unknown[]) => mockShowUndoToast(...args) }));
jest.mock("react-hot-toast", () => {
  const toast = Object.assign(jest.fn(), {
    success: jest.fn(),
    error: jest.fn(),
    loading: jest.fn(() => "loading"),
    dismiss: jest.fn(),
    custom: jest.fn(),
  });
  return { __esModule: true, default: toast, toast };
});

import toast from "react-hot-toast";
import {
  emptyProductTrash,
  moveProductToTrash,
  permanentlyDeleteProduct,
  restoreProductFromTrash,
  runBulkProductLifecycle,
} from "@/services/super-admin/product/lifecycle";
import PermanentDeleteDialog from "../PermanentDeleteDialog";
import ProductRowActions from "../ProductRowActions";
import {
  bulkActionsFor,
  describeLifecycleError,
  rowActionsFor,
  type ProductLifecycleCapabilities,
} from "../productLifecycle";
import { useProductLifecycleActions } from "../useProductLifecycleActions";
import type { AdminProductRow } from "../types";

const ALL: ProductLifecycleCapabilities = {
  publish: true,
  schedule: true,
  softDelete: true,
  restore: true,
  delete: true,
  duplicate: true,
  stock: true,
};

function row(overrides: Partial<AdminProductRow["attributes"]> = {}): AdminProductRow {
  return {
    id: "42",
    attributes: {
      lifecycleState: "published",
      removedAt: null,
      Title: "پیراهن آبی",
      Slug: "blue-shirt",
      Status: "Active",
      AverageRating: null,
      RatingCount: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      LastEditedByAdminAt: null,
      product_main_category: { data: null },
      product_variations: { data: [] },
      CoverImage: { data: null } as any,
      ...overrides,
    },
  };
}

describe("lifecycle action matrix (client mirror)", () => {
  it("offers state-appropriate row actions", () => {
    expect(rowActionsFor("published", ALL)).toEqual(["edit", "view", "duplicate", "unpublish", "trash"]);
    expect(rowActionsFor("draft", ALL)).toEqual(["edit", "preview", "duplicate", "publish", "schedule", "trash"]);
    expect(rowActionsFor("scheduled", ALL)).toEqual([
      "edit",
      "preview",
      "duplicate",
      "reschedule",
      "publish",
      "unpublish",
      "trash",
    ]);
    expect(rowActionsFor("trashed", ALL)).toEqual(["restore", "purge"]);
    expect(rowActionsFor("purged", ALL)).toEqual([]);
  });

  it("never offers permanent deletion or publishing from Trash, nor purge elsewhere", () => {
    for (const state of ["published", "draft", "scheduled"] as const) {
      expect(rowActionsFor(state, ALL)).not.toContain("purge");
      expect(rowActionsFor(state, ALL)).not.toContain("restore");
    }
    expect(rowActionsFor("trashed", ALL)).not.toContain("publish");
  });

  it("drops actions the role cannot perform", () => {
    const seller1 = { ...ALL, schedule: false, delete: false };
    expect(rowActionsFor("draft", seller1)).not.toContain("schedule");
    expect(rowActionsFor("trashed", seller1)).toEqual(["restore"]);
    expect(bulkActionsFor("trash", seller1)).toEqual(["restore"]);
  });

  it("explains lifecycle refusals in Persian", () => {
    expect(describeLifecycleError({ message: "PRODUCT_NOT_IN_TRASH", details: { code: "PRODUCT_NOT_IN_TRASH" } })).toBe(
      "حذف دائمی فقط برای محصولات داخل سطل زباله ممکن است.",
    );
    expect(describeLifecycleError({ message: "PRODUCT_SLUG_CONFLICT" })).toContain("نامک");
  });
});

describe("row actions menu", () => {
  beforeAll(() => {
    // Headless UI's menu measures its anchor; jsdom has no ResizeObserver.
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it("keeps Edit visible and puts destructive actions in the menu, marked", async () => {
    const onAction = jest.fn();
    render(<ProductRowActions row={row()} can={ALL} onAction={onAction} />);

    expect(screen.getByTestId("admin-product-edit")).toHaveAttribute("href", "/products/42");
    fireEvent.click(screen.getByTestId("admin-product-actions"));
    const trash = await screen.findByTestId("admin-product-soft-delete");
    expect(trash).toHaveAttribute("data-id", "42");
    expect(trash.className).toContain("text-red-600");
    expect(screen.queryByTestId("admin-product-permanent-delete")).toBeNull();

    fireEvent.click(trash);
    expect(onAction).toHaveBeenCalledWith("trash", expect.objectContaining({ id: "42" }));
  });

  it("offers only restore and permanent delete for a trashed product", async () => {
    render(
      <ProductRowActions
        row={row({ lifecycleState: "trashed", removedAt: "2026-09-27T08:00:00.000Z", Status: "InActive" })}
        can={ALL}
        onAction={jest.fn()}
      />,
    );

    expect(screen.queryByTestId("admin-product-edit")).toBeNull();
    fireEvent.click(screen.getByTestId("admin-product-actions"));
    expect(await screen.findByTestId("admin-product-restore")).toBeInTheDocument();
    expect(screen.getByTestId("admin-product-permanent-delete")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-product-publish")).toBeNull();
  });
});

describe("lifecycle actions", () => {
  beforeEach(() => jest.clearAllMocks());

  it("moves to Trash and lets Undo call the real restore with the trash token", async () => {
    (moveProductToTrash as jest.Mock).mockResolvedValue({ removedAt: "2026-09-27T08:00:00.000Z" });
    (restoreProductFromTrash as jest.Mock).mockResolvedValue({ state: "published", warnings: [] });
    const onChanged = jest.fn();
    const { result } = renderHook(() => useProductLifecycleActions({ onChanged }));

    await act(() => result.current.trash(row()));

    expect(moveProductToTrash).toHaveBeenCalledWith("42");
    expect(onChanged).toHaveBeenCalledTimes(1);
    const [{ message, onUndo }] = mockShowUndoToast.mock.calls[0];
    expect(message).toContain("به سطل زباله منتقل شد");

    await act(() => onUndo());
    expect(restoreProductFromTrash).toHaveBeenCalledWith("42", "2026-09-27T08:00:00.000Z");
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("دوباره منتشر شد"));
  });

  it("reports a refused permanent deletion with its reason", async () => {
    (permanentlyDeleteProduct as jest.Mock).mockRejectedValue({
      message: "PRODUCT_NOT_IN_TRASH",
      details: { code: "PRODUCT_NOT_IN_TRASH" },
    });
    const onChanged = jest.fn();
    const { result } = renderHook(() => useProductLifecycleActions({ onChanged }));

    await act(() => result.current.purge(row()));

    expect(toast.error).toHaveBeenCalledWith("حذف دائمی فقط برای محصولات داخل سطل زباله ممکن است.");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("sends a bulk command as one request and reports partial failures", async () => {
    (runBulkProductLifecycle as jest.Mock).mockResolvedValue({
      action: "purge",
      succeeded: [1],
      unchanged: [],
      failed: [{ id: 2, code: "PRODUCT_NOT_IN_TRASH" }],
      warnings: [],
    });
    const onChanged = jest.fn();
    const { result } = renderHook(() => useProductLifecycleActions({ onChanged }));

    await act(async () => {
      await result.current.bulk("purge", [row({}), { ...row(), id: "2" }]);
    });

    expect(runBulkProductLifecycle).toHaveBeenCalledTimes(1);
    expect(runBulkProductLifecycle).toHaveBeenCalledWith({ action: "purge", ids: ["42", "2"] });
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("حذف دائمی فقط برای محصولات داخل سطل زباله"), expect.anything());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("empties Trash in batches and stops when a batch makes no progress", async () => {
    (emptyProductTrash as jest.Mock)
      .mockResolvedValueOnce({ purged: 500, failed: 0, remaining: 3 })
      .mockResolvedValueOnce({ purged: 0, failed: 3, remaining: 3 });
    const onChanged = jest.fn();
    const { result } = renderHook(() => useProductLifecycleActions({ onChanged }));

    await act(() => result.current.emptyTrash("2026-09-27T08:00:00.000Z"));

    expect(emptyProductTrash).toHaveBeenCalledTimes(2);
    expect(emptyProductTrash).toHaveBeenCalledWith("2026-09-27T08:00:00.000Z");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe("permanent delete confirmation", () => {
  it("names the product and stays disabled until the phrase is typed", () => {
    const onConfirm = jest.fn();
    render(
      <PermanentDeleteDialog isOpen productTitle="پیراهن آبی" onConfirm={onConfirm} onCancel={jest.fn()} />,
    );

    expect(screen.getByText(/محصول «پیراهن آبی» برای همیشه حذف می‌شود/)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "حذف برای همیشه" });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText("عبارت تأیید حذف دائمی"), { target: { value: "حذف" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("عبارت تأیید حذف دائمی"), { target: { value: "حذف دائمی" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("states how many products a bulk deletion removes", () => {
    render(<PermanentDeleteDialog isOpen count={12} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByText(/۱۲ محصول انتخاب‌شده برای همیشه حذف می‌شود/)).toBeInTheDocument();
  });
});
