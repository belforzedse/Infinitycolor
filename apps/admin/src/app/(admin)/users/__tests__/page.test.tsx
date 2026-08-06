import { render, screen } from "@testing-library/react";

let mockTableProps: any;

jest.mock("@/components/SuperAdmin/Table", () => ({
  SuperAdminTable: (props: any) => {
    mockTableProps = props;
    return <div data-testid="users-table" />;
  },
}));
jest.mock("@/components/SuperAdmin/Layout/ContentWrapper", () => ({
  __esModule: true,
  default: ({ children }: any) => (
    <div data-testid="content-wrapper">{children}</div>
  ),
}));
jest.mock("../table", () => ({
  columns: [],
  MobileTable: () => null,
}));
jest.mock("@/services/super-admin/users/list", () => ({
  listAdminUsers: jest.fn(),
}));
jest.mock("nuqs", () => ({
  useQueryState: () => ["1", jest.fn()],
}));
jest.mock("use-debounce", () => ({
  useDebouncedCallback: (callback: (...args: any[]) => void) => {
    const debounced = (...args: any[]) => callback(...args);
    debounced.cancel = jest.fn();
    return debounced;
  },
}));

import UsersPage from "../page";
import { listAdminUsers } from "@/services/super-admin/users/list";

const mockListAdminUsers = listAdminUsers as jest.Mock;

describe("users page bounded data ownership", () => {
  beforeEach(() => {
    mockTableProps = undefined;
    mockListAdminUsers.mockReset();
  });

  it("uses the dedicated loader without a wildcard URL", async () => {
    mockListAdminUsers.mockResolvedValue({
      data: [],
      meta: {
        pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 },
        recycleCount: 0,
      },
    });

    render(<UsersPage />);

    expect(screen.getByTestId("users-table")).toBeInTheDocument();
    expect(mockTableProps.url).toBeUndefined();
    expect(mockTableProps.dataLoader).toEqual(expect.any(Function));
    expect(mockTableProps.refreshOnVisibility).toBe(false);
    expect(JSON.stringify(mockTableProps)).not.toContain("populate=*");

    const controller = new AbortController();
    await mockTableProps.dataLoader({
      page: 1,
      pageSize: 25,
      filters: [],
      signal: controller.signal,
    });

    expect(mockListAdminUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        pageSize: 25,
        removed: false,
        managerRolesOnly: false,
        sort: { field: "id", direction: "desc" },
        signal: controller.signal,
      }),
    );
  });
});
