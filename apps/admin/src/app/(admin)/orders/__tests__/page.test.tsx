import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";

let mockTableProps: any;
let mockWrapperProps: any;
let mockCapabilities = new Set<string>();
const mockRefreshOrderCounts = jest.fn();
let mockOrderCountsState: {
  counts?: Record<string, number>;
  activeReserveGroups?: number;
  loading: boolean;
  error?: string;
};

jest.mock("@/components/SuperAdmin/Table", () => ({
  refreshTable: {},
  SuperAdminTable: (props: any) => {
    mockTableProps = props;
    return <div data-testid="orders-table" />;
  },
}));
jest.mock("@/components/SuperAdmin/Layout/ContentWrapper", () => ({
  __esModule: true,
  default: (props: any) => {
    mockWrapperProps = props;
    return <div>{props.children}</div>;
  },
}));
jest.mock("../table", () => ({
  columns: [],
  MobileTable: () => null,
  bulkPrintOrders: jest.fn(),
}));
jest.mock("@/services/super-admin/orders/list", () => ({
  listAdminOrders: jest.fn(),
  listAdminShippingMethods: jest.fn(),
}));
jest.mock("@/services/super-admin/orders/adjustItems", () => ({
  changeOrderStatus: jest.fn(),
  cancelOrder: jest.fn(),
}));
jest.mock("@/hooks/useOrderStatusCounts", () => ({
  useOrderStatusCounts: () => ({
    ...mockOrderCountsState,
    refresh: mockRefreshOrderCounts,
  }),
}));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() }),
}));
const mockToast = jest.requireMock("react-hot-toast").default as jest.Mock & {
  success: jest.Mock;
  error: jest.Mock;
};
jest.mock("@/hooks/useCan", () => ({
  useCan: (capability: string) => mockCapabilities.has(capability),
}));
const mockRouterPush = jest.fn();
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("jotai", () => ({ useAtom: () => [false, jest.fn()] }));
// Stable across renders like the real hook: a new function each render would
// re-run the page's search effect, and its setPage, on every render.
jest.mock("use-debounce", () => {
  const { useRef } = jest.requireActual("react");
  return {
    useDebouncedCallback: (callback: (...args: any[]) => void) => {
      const debounced = useRef(null);
      if (!debounced.current) {
        const fn: any = (...args: any[]) => fn.callback(...args);
        fn.cancel = jest.fn();
        debounced.current = fn;
      }
      debounced.current.callback = callback;
      return debounced.current;
    },
  };
});

import OrdersPage from "../page";
import {
  listAdminOrders,
  listAdminShippingMethods,
} from "@/services/super-admin/orders/list";
import { cancelOrder, changeOrderStatus } from "@/services/super-admin/orders/adjustItems";

function renderPage(searchParams = "", onUrlUpdate?: (event: UrlUpdateEvent) => void) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
      <OrdersPage />
    </NuqsTestingAdapter>,
  );
}

describe("orders page bounded data ownership", () => {
  beforeEach(() => {
    mockTableProps = undefined;
    mockWrapperProps = undefined;
    mockCapabilities = new Set([
      "order.read",
      "order.status.update",
      "order.manual.create",
    ]);
    mockRefreshOrderCounts.mockClear();
    mockOrderCountsState = {
      counts: {
        all: 12,
        paying: 2,
        inprogress: 4,
        completed: 5,
        cancelled: 1,
        manual: 3,
        anipo_attention: 2,
      },
      activeReserveGroups: 2,
      loading: false,
      error: undefined,
    };
    (listAdminOrders as jest.Mock).mockReset().mockResolvedValue({
      data: [],
      meta: { pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 } },
    });
    (listAdminShippingMethods as jest.Mock)
      .mockReset()
      .mockImplementation(() => new Promise(() => undefined));
  });

  it("uses one POST-backed loader with controlled filters", async () => {
    renderPage();

    expect(screen.getByTestId("orders-table")).toBeInTheDocument();
    expect(mockTableProps.url).toBeUndefined();
    expect(mockTableProps.dataLoader).toEqual(expect.any(Function));
    expect(mockTableProps.refreshOnVisibility).toBe(false);
    expect(mockWrapperProps.filters).toEqual([]);
    expect(mockWrapperProps.onFiltersChange).toEqual(expect.any(Function));

    const controller = new AbortController();
    await mockTableProps.dataLoader({
      page: 1,
      pageSize: 25,
      filters: [],
      signal: controller.signal,
    });
    expect(listAdminOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        pageSize: 25,
        tab: "all",
        sort: "newest",
        signal: controller.signal,
      }),
    );
  });

  it("uses the matching single-order permissions for bulk actions", () => {
    mockCapabilities = new Set(["order.read"]);
    const { unmount } = renderPage();

    expect(mockTableProps.enableSelection).toBe(true);
    expect(mockTableProps.bulkOptions.map((option: { id: string }) => option.id)).toEqual([
      "print",
    ]);

    unmount();
    mockCapabilities = new Set(["order.read", "order.status.update"]);
    renderPage();

    // No `status-Started`: nothing in the backend transition chain leads to
    // Started, so offering it could only ever produce a 409.
    expect(mockTableProps.bulkOptions.map((option: { id: string }) => option.id)).toEqual([
      "print",
      "status-Done",
      "status-Shipment",
    ]);

    unmount();
    mockCapabilities = new Set(["order.read", "order.status.update", "order.cancel"]);
    renderPage();

    expect(mockTableProps.bulkOptions.map((option: { id: string }) => option.id)).toEqual([
      "print",
      "status-Done",
      "status-Shipment",
      "cancel",
    ]);
  });

  it("loads pending-payment orders in their own tab", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /در انتظار پرداخت/ }));
    await mockTableProps.dataLoader({
      page: 1,
      pageSize: 25,
      filters: [],
      signal: new AbortController().signal,
    });

    expect(listAdminOrders).toHaveBeenLastCalledWith(
      expect.objectContaining({ tab: "paying" }),
    );
  });

  it("shows Seller 2 the counted Anipo review tab through the existing order list", async () => {
    mockCapabilities = new Set(["order.read", "order.shipping.manage"]);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /نیاز به بررسی آنیپو ۲/ }));
    await mockTableProps.dataLoader({ page: 1, pageSize: 25, filters: [], signal: new AbortController().signal });
    expect(listAdminOrders).toHaveBeenLastCalledWith(expect.objectContaining({ tab: "anipo_attention" }));
  });

  it("shows Persian counters for every order tab and keeps active reserves separate", () => {
    renderPage();

    expect(screen.getByRole("button", { name: /همه ۱۲/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /در حال انجام ۴/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /سفارش‌های دستی ۳/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /رزروهای فعال ۲/ })).toHaveAttribute(
      "href",
      "/orders/reserve",
    );
  });

  it("keeps the order table usable when the independent counter request fails", () => {
    mockOrderCountsState = {
      loading: false,
      error: "شمارش سفارش‌ها موقتاً در دسترس نیست.",
    };

    renderPage();

    expect(screen.getByTestId("orders-table")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "شمارش سفارش‌ها موقتاً در دسترس نیست.",
    );
    expect(screen.getByRole("button", { name: /همه —/ })).toBeInTheDocument();
  });

  it("combines checked shipping methods as one server-side filter", async () => {
    (listAdminShippingMethods as jest.Mock).mockResolvedValue([
      { code: "post", title: "پست" },
      { code: "tipax", title: "تیپاکس" },
      { code: "pickup", title: "حضوری" },
    ]);
    renderPage();

    const post = await screen.findByRole("checkbox", { name: "پست" });
    const tipax = screen.getByRole("checkbox", { name: "تیپاکس" });
    fireEvent.click(post);
    fireEvent.click(tipax);

    await waitFor(() => expect(mockTableProps.isFiltered).toBe(true));
    await mockTableProps.dataLoader({
      page: 1,
      pageSize: 25,
      filters: [],
      signal: new AbortController().signal,
    });

    expect(listAdminOrders).toHaveBeenLastCalledWith(
      expect.objectContaining({ shippingMethodCodes: ["post", "tipax"] }),
    );

    fireEvent.click(post);
    await waitFor(() =>
      expect(mockTableProps.dataLoaderKey).toContain('"shippingMethodCodes":["tipax"]'),
    );
  });

  it("narrows the list to reserve orders with the reserve checkbox", async () => {
    renderPage();

    const reserveOnly = screen.getByRole("checkbox", {
      name: "نمایش سفارش‌های رزروی",
    });
    expect(reserveOnly).not.toBeChecked();
    expect(mockTableProps.isFiltered).toBe(false);

    fireEvent.click(reserveOnly);

    await waitFor(() => expect(mockTableProps.isFiltered).toBe(true));
    expect(mockTableProps.dataLoaderKey).toContain('"reserveOnly":true');
    // The toggle rides along with the request, never with the operator's
    // advanced filters, so it must not surface as a removable chip.
    expect(mockWrapperProps.filters).toEqual([]);

    const ownFilter = { field: "[Description]", operator: "$containsi", value: "vip" };
    await mockTableProps.dataLoader({
      page: 1,
      pageSize: 25,
      filters: [ownFilter],
      signal: new AbortController().signal,
    });
    expect(listAdminOrders).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [
          ownFilter,
          { field: "[reserve_shipment][id]", operator: "$notNull", value: "true" },
        ],
      }),
    );

    fireEvent.click(reserveOnly);
    await waitFor(() => expect(mockTableProps.isFiltered).toBe(false));
    await mockTableProps.dataLoader({
      page: 1,
      pageSize: 25,
      filters: [ownFilter],
      signal: new AbortController().signal,
    });
    expect(listAdminOrders).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: [ownFilter] }),
    );
  });

  it("keeps reserve shipments off the order-status tabs", () => {
    renderPage();

    expect(
      screen.queryByRole("button", { name: "سفارش‌های رزروی" }),
    ).not.toBeInTheDocument();
  });

  describe("bulk status changes with held reserve orders", () => {
    // Fulfilment is Started -> Done -> Shipment, so `Done` is the status a
    // `Shipment` transition is reachable from, and the only one the 48h reserve
    // hold can block.
    const row = (id: string, reserveIsHeld: boolean, Status = "Done") => ({
      id,
      attributes: { Status, reserveIsHeld },
    });

    beforeEach(() => {
      (changeOrderStatus as jest.Mock).mockClear();
      mockToast.mockClear();
      mockToast.error.mockClear();
      mockToast.success.mockClear();
    });

    it("skips held orders and applies the change to the rest", async () => {
      renderPage();

      await mockTableProps.onBulkAction("status-Shipment", [
        row("1", false),
        row("2", true),
        row("3", false),
      ]);

      expect(changeOrderStatus).toHaveBeenCalledTimes(2);
      expect(changeOrderStatus).toHaveBeenCalledWith("1", "Shipment");
      expect(changeOrderStatus).toHaveBeenCalledWith("3", "Shipment");
      expect(changeOrderStatus).not.toHaveBeenCalledWith("2", "Shipment");
      expect(mockToast).toHaveBeenCalledWith(
        "1 سفارش تغییر نکرد: در مهلت رزرو",
        expect.anything(),
      );
      expect(mockRefreshOrderCounts).toHaveBeenCalledTimes(1);
    });

    it("changes nothing when every selected order is held", async () => {
      renderPage();

      await mockTableProps.onBulkAction("status-Shipment", [row("1", true), row("2", true)]);

      expect(changeOrderStatus).not.toHaveBeenCalled();
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringContaining("در مهلت رزرو"),
      );
    });

    /**
     * «ارسال» applied to orders sitting in «در حال انجام» cannot succeed: the
     * chain is Started → Done → Shipment, so an order must be completed first.
     * Nothing is sent, and the message names the status that IS reachable.
     */
    it("refuses a transition that skips a step, naming the allowed one", async () => {
      renderPage();

      await mockTableProps.onBulkAction("status-Shipment", [
        row("1", false, "Started"),
        row("2", false, "Started"),
      ]);

      expect(changeOrderStatus).not.toHaveBeenCalled();
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringContaining("تکمیل شده"),
      );
    });

    it("applies a transition that is the next step in the chain", async () => {
      renderPage();

      await mockTableProps.onBulkAction("status-Done", [
        row("1", false, "Started"),
      ]);

      expect(changeOrderStatus).toHaveBeenCalledWith("1", "Done");
    });

    it("skips held reserve orders when completing would automatically ship them", async () => {
      renderPage();

      await mockTableProps.onBulkAction("status-Done", [
        row("1", true, "Started"),
        row("2", false, "Started"),
      ]);

      expect(changeOrderStatus).toHaveBeenCalledTimes(1);
      expect(changeOrderStatus).not.toHaveBeenCalledWith("1", "Done");
      expect(changeOrderStatus).toHaveBeenCalledWith("2", "Done");
    });

    it("cancels held reserve orders through the cancel endpoint", async () => {
      mockCapabilities = new Set(["order.read", "order.status.update", "order.cancel"]);
      (cancelOrder as jest.Mock).mockClear().mockResolvedValue({ success: true });
      renderPage();

      await mockTableProps.onBulkAction("cancel", [
        row("1", false),
        row("2", true),
        { id: "3", attributes: { Status: "Cancelled", reserveIsHeld: false } },
      ]);

      expect(cancelOrder).toHaveBeenCalledTimes(2);
      expect(cancelOrder).toHaveBeenCalledWith(1);
      expect(cancelOrder).toHaveBeenCalledWith(2);
      expect(changeOrderStatus).not.toHaveBeenCalled();
      expect(mockToast.success).toHaveBeenCalledWith("2 سفارش لغو شد.");
      expect(mockToast).toHaveBeenCalledWith("1 سفارش از قبل لغو شده بود.");
      expect(mockRefreshOrderCounts).toHaveBeenCalledTimes(1);
    });

    it("refreshes counters when only some cancellation requests succeed", async () => {
      mockCapabilities = new Set([
        "order.read",
        "order.status.update",
        "order.cancel",
      ]);
      (cancelOrder as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(new Error("failed"));
      renderPage();

      await mockTableProps.onBulkAction("cancel", [
        row("1", false),
        row("2", false),
      ]);

      expect(mockToast.success).toHaveBeenCalledWith("1 سفارش لغو شد.");
      expect(mockToast.error).toHaveBeenCalledWith(
        "1 سفارش لغو نشد. دوباره تلاش کنید.",
      );
      expect(mockRefreshOrderCounts).toHaveBeenCalledTimes(1);
    });
  });

  describe("advanced filters in the URL", () => {
    const ownFilter = { field: "[Description]", operator: "$containsi", value: "vip" };

    it("restores the filters a reload or a shared link carries in ?af=", () => {
      renderPage(new URLSearchParams({ af: JSON.stringify([ownFilter]) }).toString());

      expect(mockWrapperProps.filters).toEqual([ownFilter]);
      expect(mockTableProps.isFiltered).toBe(true);
    });

    it("writes a filter change to the URL", async () => {
      const onUrlUpdate = jest.fn();
      renderPage("?page=3", onUrlUpdate);

      await act(async () => mockWrapperProps.onFiltersChange([ownFilter]));

      await waitFor(() => {
        const { searchParams } = onUrlUpdate.mock.calls.at(-1)?.[0] ?? { searchParams: new URLSearchParams() };
        expect(JSON.parse(decodeURIComponent(searchParams.get("af") ?? "[]"))).toEqual([ownFilter]);
        expect(searchParams.has("page")).toBe(false);
      });
      expect(mockWrapperProps.filters).toEqual([ownFilter]);
    });
  });
});
