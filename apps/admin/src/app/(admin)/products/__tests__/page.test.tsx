import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";

let mockTableProps: any;
let mockWrapperProps: any;

jest.mock("@/components/SuperAdmin/Table", () => ({
  refreshTable: require("jotai").atom(false),
  SuperAdminTable: (props: any) => {
    mockTableProps = props;
    return <div data-testid="products-table" />;
  },
}));
jest.mock("@/components/SuperAdmin/Table/refreshTableAtom", () => ({
  refreshTable: jest.requireMock("@/components/SuperAdmin/Table").refreshTable,
}));
jest.mock("@/components/SuperAdmin/Layout/ContentWrapper", () => ({
  __esModule: true,
  default: (props: any) => {
    mockWrapperProps = props;
    return <div>{props.children}</div>;
  },
}));
jest.mock("@/services/super-admin/product/list", () => {
  const actual = jest.requireActual("@/services/super-admin/product/list");
  return {
    ...actual,
    listAdminProducts: jest.fn(),
    getAdminProductCounts: jest.fn(),
  };
});
jest.mock("@/services", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: [] }), put: jest.fn(), post: jest.fn() },
}));
let mockCapabilities = new Set<string>();
jest.mock("@/hooks/useCan", () => ({
  useCan: (capability: string) => mockCapabilities.has(capability),
}));
jest.mock("@/hooks/useLegacyFilterQueryCleanup", () => ({
  useLegacyFilterQueryCleanup: jest.fn(),
}));
jest.mock("zaman", () => ({ DatePicker: () => null, TimePicker: () => null }));

import ProductsPage from "../page";
import { getAdminProductCounts, listAdminProducts } from "@/services/super-admin/product/list";

const COUNTS = { all: 12, published: 7, drafts: 3, scheduled: 2, trash: 4 };

function renderPage(searchParams = "", onUrlUpdate?: (event: UrlUpdateEvent) => void) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
      <ProductsPage />
    </NuqsTestingAdapter>,
  );
}

async function loadFirstPage() {
  const controller = new AbortController();
  await act(async () => {
    await mockTableProps.dataLoader({ page: 1, pageSize: 25, filters: [], signal: controller.signal });
  });
  return controller;
}

const bulkIds = () => (mockTableProps.bulkOptions as Array<{ id: string }>).map((option) => option.id);

describe("products lifecycle page", () => {
  beforeEach(() => {
    mockTableProps = undefined;
    mockWrapperProps = undefined;
    mockCapabilities = new Set(["product.read"]);
    (getAdminProductCounts as jest.Mock).mockReset().mockResolvedValue({
      counts: COUNTS,
      trashRetentionDays: 0,
    });
    (listAdminProducts as jest.Mock).mockReset().mockResolvedValue({
      data: [],
      meta: {
        pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 },
        counts: COUNTS,
        recycleCount: 4,
        trashRetentionDays: 0,
      },
    });
  });

  it("shows the five lifecycle tabs with their counts", async () => {
    renderPage();

    for (const [label, count] of [
      ["همه", "۱۲"],
      ["منتشر شده", "۷"],
      ["پیش‌نویس‌ها", "۳"],
      ["زمان‌بندی شده", "۲"],
      ["سطل زباله", "۴"],
    ]) {
      const tab = await screen.findByRole("button", { name: new RegExp(label) });
      await waitFor(() => expect(tab).toHaveTextContent(count));
    }
  });

  it("loads the All tab server-side by default, never the Trash", async () => {
    renderPage();
    const controller = await loadFirstPage();

    expect(mockTableProps.url).toBeUndefined();
    expect(listAdminProducts).toHaveBeenCalledWith(
      expect.objectContaining({ view: "all", sort: "last-edited", page: 1, pageSize: 25, signal: controller.signal }),
    );
    expect(mockWrapperProps.hasRecycleBin).toBeFalsy();
  });

  it("restores the tab, search, filters and sort from the URL", async () => {
    renderPage("?view=scheduled&q=iphone&category=12&stock=out&sort=scheduled-desc");
    await loadFirstPage();

    expect(listAdminProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        view: "scheduled",
        sort: "scheduled-desc",
        search: "iphone",
        categoryId: 12,
        stock: "out",
      }),
    );
    expect(getAdminProductCounts).toHaveBeenCalledWith(
      expect.objectContaining({ search: "iphone", categoryId: 12, stock: "out" }),
    );
  });

  it("switches tabs through the URL and resets the page", async () => {
    const onUrlUpdate = jest.fn();
    renderPage("?q=shirt&page=3", onUrlUpdate);

    fireEvent.click(await screen.findByRole("button", { name: /سطل زباله/ }));

    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const update: UrlUpdateEvent = onUrlUpdate.mock.calls.at(-1)[0];
    expect(update.searchParams.get("view")).toBe("trash");
    expect(update.searchParams.get("q")).toBe("shirt");
    expect(update.searchParams.has("page")).toBe(false);
    expect(update.options.history).toBe("push");
  });

  it("offers Trash only restore and permanent delete, by capability", async () => {
    mockCapabilities = new Set(["product.read", "product.restore"]);
    const { unmount } = renderPage("?view=trash");
    await screen.findByTestId("products-table");
    expect(bulkIds()).toEqual(["restore"]);
    unmount();

    mockCapabilities = new Set(["product.read", "product.restore", "product.delete"]);
    renderPage("?view=trash");
    await screen.findByTestId("products-table");
    expect(bulkIds()).toEqual(["restore", "purge"]);
  });

  it("never offers permanent deletion outside Trash", async () => {
    mockCapabilities = new Set([
      "product.read",
      "product.publish",
      "product.schedule",
      "product.softDelete",
      "product.restore",
      "product.delete",
      "product.stock.update",
    ]);
    for (const view of ["", "?view=published", "?view=drafts", "?view=scheduled"]) {
      const { unmount } = renderPage(view);
      await screen.findByTestId("products-table");
      expect(bulkIds()).not.toContain("purge");
      expect(bulkIds()).toContain("trash");
      unmount();
    }
  });

  it("gives each tab its own bulk actions", async () => {
    mockCapabilities = new Set(["product.read", "product.publish", "product.schedule", "product.softDelete"]);
    const expectations: Array<[string, string[]]> = [
      ["?view=published", ["unpublish", "trash"]],
      ["?view=drafts", ["publish", "schedule", "trash"]],
      ["?view=scheduled", ["publish", "schedule", "unpublish", "trash"]],
    ];
    for (const [query, expected] of expectations) {
      const { unmount } = renderPage(query);
      await screen.findByTestId("products-table");
      expect(bulkIds()).toEqual(expected);
      unmount();
    }
  });

  it("offers no selection without any lifecycle capability", async () => {
    renderPage();
    await screen.findByTestId("products-table");
    expect(mockTableProps.enableSelection).toBe(false);
  });

  it("explains retention and offers Empty Trash to those who may delete permanently", async () => {
    mockCapabilities = new Set(["product.read", "product.delete"]);
    (getAdminProductCounts as jest.Mock).mockResolvedValue({ counts: COUNTS, trashRetentionDays: 30 });
    renderPage("?view=trash");

    const notice = await screen.findByTestId("admin-products-trash-notice");
    await waitFor(() => expect(notice).toHaveTextContent("پس از ۳۰ روز برای همیشه حذف می‌شوند"));
    expect(await screen.findByTestId("admin-products-empty-trash")).toBeInTheDocument();
  });

  it("uses the tab's own empty state", async () => {
    renderPage("?view=scheduled");
    await screen.findByTestId("products-table");
    render(mockTableProps.emptyState);
    expect(screen.getByText("هیچ محصولی برای انتشار زمان‌بندی نشده است.")).toBeInTheDocument();
  });
});
