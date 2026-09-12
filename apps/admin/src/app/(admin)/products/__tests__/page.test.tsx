import { act, render, screen } from "@testing-library/react";

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
let mockCapabilities = new Set<string>();
jest.mock("@/hooks/useCan", () => ({
  useCan: (capability: string) => mockCapabilities.has(capability),
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


/**
 * Bulk actions had no capability coverage at all — `useCan` was mocked to a
 * blanket `true`, so nothing caught a gating regression. That matters most for
 * the removal pair: `product.softDelete` is the reversible recycle-bin move
 * available from Seller 1 up, while `product.delete` is permanent and
 * Superadmin-only, and the UI used to gate both on the latter.
 */
describe("products page bulk action gating", () => {
  const ids = () =>
    (mockTableProps.bulkOptions as { id: string }[]).map((option) => option.id);

  beforeEach(() => {
    mockTableProps = undefined;
    (listAdminProducts as jest.Mock).mockReset().mockResolvedValue({
      data: [],
      meta: {
        pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 },
        recycleCount: 0,
      },
    });
  });

  afterEach(() => {
    mockCapabilities = new Set(["product.read"]);
  });

  it("offers nothing, and no selection, without any write capability", () => {
    mockCapabilities = new Set(["product.read"]);
    render(<ProductsPage />);

    expect(ids()).toEqual([]);
    expect(mockTableProps.enableSelection).toBe(false);
  });

  it("lets a seller soft-delete without granting permanent deletion", () => {
    mockCapabilities = new Set(["product.read", "product.softDelete"]);
    render(<ProductsPage />);

    expect(ids()).toEqual(["soft_delete"]);
    expect(ids()).not.toContain("permanent_delete");
    expect(mockWrapperProps.hasRecycleBin).toBe(true);
  });

  it("confirms before removing a selection, as permanent delete already did", () => {
    mockCapabilities = new Set(["product.read", "product.softDelete"]);
    render(<ProductsPage />);

    const softDelete = (mockTableProps.bulkOptions as any[]).find(
      (option) => option.id === "soft_delete",
    );
    expect(softDelete.variant).toBe("danger");
    expect(softDelete.confirm).toBeTruthy();
  });

  it("asks for the value instead of using a native prompt", () => {
    mockCapabilities = new Set(["product.read", "product.stock.update"]);
    render(<ProductsPage />);

    const setStock = (mockTableProps.bulkOptions as any[]).find(
      (option) => option.id === "set_stock",
    );
    expect(setStock.confirm.input.type).toBe("number");
    expect(setStock.confirm.input.validate("")).toBeTruthy();
    expect(setStock.confirm.input.validate("-1")).toBeTruthy();
    expect(setStock.confirm.input.validate("5")).toBeNull();
  });

  it("keeps permanent deletion behind product.delete in the recycle bin", () => {
    mockCapabilities = new Set([
      "product.read",
      "product.softDelete",
      "product.restore",
    ]);
    render(<ProductsPage />);

    act(() => mockWrapperProps.setIsRecycleBinOpen(true));
    expect(ids()).toEqual(["restore"]);

    mockCapabilities = new Set([
      "product.read",
      "product.restore",
      "product.delete",
    ]);
    render(<ProductsPage />);
    act(() => mockWrapperProps.setIsRecycleBinOpen(true));
    expect(ids()).toContain("permanent_delete");
  });
});
