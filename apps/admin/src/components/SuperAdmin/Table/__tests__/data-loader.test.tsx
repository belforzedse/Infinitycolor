import { act, render, waitFor } from "@testing-library/react";

const mockSetQueryState = jest.fn();
const mockSetRefresh = jest.fn();

jest.mock("nuqs", () => ({
  useQueryState: (key: string) => {
    if (key === "filter") return [[], mockSetQueryState];
    if (key === "totalSize") return [0, mockSetQueryState];
    if (key === "pageSize") return ["25", mockSetQueryState];
    return ["1", mockSetQueryState];
  },
}));
jest.mock("jotai", () => ({
  atom: () => ({}),
  useAtom: () => [false, mockSetRefresh],
}));
jest.mock("@/components/Skeletons/ReportTableSkeleton", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../AnimatedTableRow", () => ({
  AnimatedTableRow: ({ children }: { children: React.ReactNode }) => (
    <tr>{children}</tr>
  ),
}));

import { SuperAdminTable } from "../index";

describe("SuperAdminTable bounded data loader", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSetQueryState.mockReset();
    mockSetRefresh.mockReset();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("owns one request and does not refetch on visibility when disabled", async () => {
    const dataLoader = jest.fn().mockResolvedValue({
      data: [],
      meta: {
        pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 },
        recycleCount: 0,
      },
    });

    const view = render(
      <SuperAdminTable
        columns={[]}
        dataLoader={dataLoader}
        dataLoaderKey="users-active"
        refreshOnVisibility={false}
      />,
    );

    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });

    await waitFor(() => expect(dataLoader).toHaveBeenCalledTimes(1));
    expect(dataLoader).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 25, filters: [] }),
    );

    view.rerender(
      <SuperAdminTable
        columns={[]}
        dataLoader={dataLoader}
        dataLoaderKey="users-active"
        refreshOnVisibility={false}
      />,
    );
    document.dispatchEvent(new Event("visibilitychange"));

    await act(async () => {
      jest.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(dataLoader).toHaveBeenCalledTimes(1);
  });
});
