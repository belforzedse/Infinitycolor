import { render, screen } from "@testing-library/react";

let mockTableProps: any;
let mockWrapperProps: any;

jest.mock("@/components/SuperAdmin/Table", () => ({
  refreshTable: {},
  SuperAdminTable: (props: any) => {
    mockTableProps = props;
    return <div data-testid="products-table" />;
  },
}));
jest.mock("@/components/SuperAdmin/Layout/ContentWrapper", () => ({
  __esModule: true,
  default: (props: any) => {
    mockWrapperProps = props;
    return <div>{props.children}</div>;
  },
}));
jest.mock("../table", () => ({ columns: [], MobileTable: () => null }));
jest.mock("@/services/super-admin/product/list", () => ({
  listAdminProducts: jest.fn(),
}));
jest.mock("@/services", () => ({
  apiClient: { put: jest.fn(), delete: jest.fn() },
}));
jest.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ isStoreManager: false, isFounder: false }),
}));
jest.mock("@/hooks/useEditorRedirect", () => ({
  useEditorRedirect: jest.fn(),
}));
jest.mock("@/components/Kits/ConfirmDialog", () => () => null);
jest.mock("jotai", () => ({ useAtom: () => [false, jest.fn()] }));
jest.mock("nuqs", () => ({ useQueryState: () => ["1", jest.fn()] }));
jest.mock("use-debounce", () => ({
  useDebouncedCallback: (callback: (...args: any[]) => void) => {
    const debounced = (...args: any[]) => callback(...args);
    debounced.cancel = jest.fn();
    return debounced;
  },
}));

import ProductsPage from "../page";
import { listAdminProducts } from "@/services/super-admin/product/list";

describe("products page bounded data ownership", () => {
  beforeEach(() => {
    mockTableProps = undefined;
    mockWrapperProps = undefined;
    (listAdminProducts as jest.Mock).mockReset().mockResolvedValue({
      data: [],
      meta: {
        pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 },
        recycleCount: 0,
      },
    });
  });

  it("uses one server-side loader for standard, stock, and sales sorts", async () => {
    render(<ProductsPage />);

    expect(screen.getByTestId("products-table")).toBeInTheDocument();
    expect(mockTableProps.url).toBeUndefined();
    expect(mockTableProps.dataLoader).toEqual(expect.any(Function));
    expect(mockTableProps.refreshOnVisibility).toBe(false);
    expect(mockWrapperProps.apiUrl).toBeUndefined();
    expect(mockWrapperProps.filters).toEqual([]);

    const controller = new AbortController();
    await mockTableProps.dataLoader({
      page: 1,
      pageSize: 25,
      filters: [],
      signal: controller.signal,
    });
    expect(listAdminProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        pageSize: 25,
        removed: false,
        sort: "last-edited",
        signal: controller.signal,
      }),
    );
  });
});
