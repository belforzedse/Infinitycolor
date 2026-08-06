import { render, screen } from "@testing-library/react";

let mockTableProps: any;
let mockWrapperProps: any;

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
}));
jest.mock("@/services/super-admin/orders/adjustItems", () => ({
  changeOrderStatus: jest.fn(),
}));
jest.mock("jotai", () => ({ useAtom: () => [false, jest.fn()] }));
jest.mock("nuqs", () => ({ useQueryState: () => ["1", jest.fn()] }));
jest.mock("use-debounce", () => ({
  useDebouncedCallback: (callback: (...args: any[]) => void) => {
    const debounced = (...args: any[]) => callback(...args);
    debounced.cancel = jest.fn();
    return debounced;
  },
}));

import OrdersPage from "../page";
import { listAdminOrders } from "@/services/super-admin/orders/list";

describe("orders page bounded data ownership", () => {
  beforeEach(() => {
    mockTableProps = undefined;
    mockWrapperProps = undefined;
    (listAdminOrders as jest.Mock).mockReset().mockResolvedValue({
      data: [],
      meta: { pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 } },
    });
  });

  it("uses one POST-backed loader with controlled filters", async () => {
    render(<OrdersPage />);

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
        sort: "last-edited",
        signal: controller.signal,
      }),
    );
  });
});
