import { act, render, screen, waitFor } from "@testing-library/react";
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";

let mockTableProps: any;
let mockWrapperProps: any;

jest.mock("@/components/SuperAdmin/Table", () => ({
  SuperAdminTable: (props: any) => {
    mockTableProps = props;
    return <div data-testid="users-table" />;
  },
}));
jest.mock("@/components/SuperAdmin/Layout/ContentWrapper", () => ({
  __esModule: true,
  default: (props: any) => {
    mockWrapperProps = props;
    return <div data-testid="content-wrapper">{props.children}</div>;
  },
}));
jest.mock("../table", () => ({
  columns: [],
  MobileTable: () => null,
}));
jest.mock("@/services/super-admin/users/list", () => ({
  listAdminUsers: jest.fn(),
}));
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

import UsersPage from "../page";
import { listAdminUsers } from "@/services/super-admin/users/list";

const mockListAdminUsers = listAdminUsers as jest.Mock;

function renderPage(searchParams = "", onUrlUpdate?: (event: UrlUpdateEvent) => void) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
      <UsersPage />
    </NuqsTestingAdapter>,
  );
}

describe("users page bounded data ownership", () => {
  beforeEach(() => {
    mockTableProps = undefined;
    mockWrapperProps = undefined;
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

    renderPage();

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

  it("keeps advanced filters in the URL: restored from ?af=, cleared from it", async () => {
    const filter = { field: "[phone]", operator: "$containsi", value: "0912" };
    const onUrlUpdate = jest.fn();
    renderPage(new URLSearchParams({ af: JSON.stringify([filter]), page: "2" }).toString(), onUrlUpdate);
    expect(mockWrapperProps.filters).toEqual([filter]);

    await act(async () => mockWrapperProps.onFiltersChange([]));

    await waitFor(() => expect(onUrlUpdate.mock.calls.at(-1)?.[0].queryString).toBe(""));
    expect(mockWrapperProps.filters).toEqual([]);
  });
});
