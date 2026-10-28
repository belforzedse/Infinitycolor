import { act, renderHook, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { refreshTable } from "@/components/SuperAdmin/Table/refreshTableAtom";

jest.mock("@/services/super-admin/orders/list", () => ({
  getAdminOrderCounts: jest.fn(),
}));

import { getAdminOrderCounts } from "@/services/super-admin/orders/list";
import { useOrderStatusCounts } from "../useOrderStatusCounts";

const result = {
  counts: {
    all: 12,
    paying: 2,
    inprogress: 4,
    completed: 5,
    cancelled: 1,
    manual: 3,
  },
  activeReserveGroups: 2,
};

describe("useOrderStatusCounts", () => {
  beforeEach(() => {
    (getAdminOrderCounts as jest.Mock).mockReset().mockResolvedValue(result);
    getDefaultStore().set(refreshTable, false);
  });

  it("loads the current non-tab filters and supports an explicit mutation refresh", async () => {
    const filters = [
      { field: "[Description]", operator: "$containsi", value: "ویژه" },
    ];
    const shippingMethodCodes = ["post"];
    const { result: hook } = renderHook(() =>
      useOrderStatusCounts({ filters, search: "۱۲۳", shippingMethodCodes }),
    );

    await waitFor(() => expect(hook.current.loading).toBe(false));
    expect(hook.current.counts).toEqual(result.counts);
    expect(getAdminOrderCounts).toHaveBeenCalledWith(
      expect.objectContaining({ filters, search: "۱۲۳", shippingMethodCodes }),
    );

    act(() => hook.current.refresh());
    await waitFor(() => expect(getAdminOrderCounts).toHaveBeenCalledTimes(2));
  });

  it("does not keep stale counts when the aggregate request fails", async () => {
    (getAdminOrderCounts as jest.Mock).mockRejectedValueOnce(
      new Error("offline"),
    );
    const filters: never[] = [];
    const shippingMethodCodes: string[] = [];
    const { result: hook } = renderHook(() =>
      useOrderStatusCounts({ filters, search: "", shippingMethodCodes }),
    );

    await waitFor(() => expect(hook.current.loading).toBe(false));
    expect(hook.current.counts).toBeUndefined();
    expect(hook.current.error).toBe("شمارش سفارش‌ها موقتاً در دسترس نیست.");
  });

  it("refreshes the review count after a row-level Anipo action refreshes the table", async () => {
    renderHook(() => useOrderStatusCounts({ filters: [], search: "", shippingMethodCodes: [] }));
    await waitFor(() => expect(getAdminOrderCounts).toHaveBeenCalledTimes(1));
    act(() => getDefaultStore().set(refreshTable, true));
    await waitFor(() => expect(getAdminOrderCounts).toHaveBeenCalledTimes(2));
    getDefaultStore().set(refreshTable, false);
  });

  it("refetches for count criteria but not tab, page, or sort changes", async () => {
    const initialFilters = [
      { field: "[Description]", operator: "$containsi", value: "ویژه" },
    ];
    type ViewProps = {
      filters: typeof initialFilters;
      search: string;
      shippingMethodCodes: string[];
      tab: string;
      page: number;
      sort: string;
    };
    const initialProps: ViewProps = {
      filters: initialFilters,
      search: "",
      shippingMethodCodes: ["post"],
      tab: "all",
      page: 1,
      sort: "newest",
    };
    const { rerender } = renderHook(
      ({ filters, search, shippingMethodCodes }: ViewProps) =>
        useOrderStatusCounts({ filters, search, shippingMethodCodes }),
      { initialProps },
    );

    await waitFor(() => expect(getAdminOrderCounts).toHaveBeenCalledTimes(1));
    rerender({ ...initialProps, tab: "completed", page: 2, sort: "oldest" });
    await act(async () => Promise.resolve());
    expect(getAdminOrderCounts).toHaveBeenCalledTimes(1);

    rerender({ ...initialProps, search: "رضا" });
    await waitFor(() => expect(getAdminOrderCounts).toHaveBeenCalledTimes(2));
  });
});
