import { render, screen, waitFor } from "@testing-library/react";

jest.mock("@/services", () => ({
  apiClient: { get: jest.fn() },
}));
jest.mock("jotai", () => ({
  useAtom: () => [false, jest.fn()],
}));
jest.mock("@/components/SuperAdmin/Table", () => ({
  refreshTable: {},
}));
jest.mock("@/components/SuperAdmin/Pagination", () => ({
  __esModule: true,
  default: () => <div data-testid="pagination" />,
}));
jest.mock("@/components/SuperAdmin/Pagination/PageSizeSelect", () => ({
  __esModule: true,
  default: () => <div data-testid="page-size-select" />,
}));
jest.mock("../Button/RecycleBin", () => ({
  __esModule: true,
  default: () => <button type="button">recycle</button>,
}));
jest.mock("../Button/Add", () => ({
  __esModule: true,
  default: () => <button type="button">add</button>,
}));
jest.mock("../Button/Filter", () => ({
  __esModule: true,
  default: () => <button type="button">filter</button>,
}));

import ContentWrapper from "../index";
import { apiClient } from "@/services";

const mockGet = apiClient.get as jest.Mock;

describe("ContentWrapper request ownership", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("renders the data child once and performs one generic recycle-count request", async () => {
    mockGet.mockResolvedValue({ meta: { pagination: { total: 3 } } });

    render(
      <ContentWrapper
        title="Synthetic"
        hasRecycleBin
        hasPagination
        apiUrl="/synthetic-items"
      >
        <div data-testid="data-child" />
      </ContentWrapper>,
    );

    expect(screen.getAllByTestId("data-child")).toHaveLength(1);
    expect(screen.getAllByTestId("pagination")).toHaveLength(1);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    expect(mockGet).toHaveBeenCalledWith(
      "/synthetic-items?filters[removedAt][$null]=false",
    );
  });

  it("does not issue a second count request when endpoint metadata owns the count", () => {
    render(
      <ContentWrapper title="Synthetic" hasRecycleBin recycleCount={7}>
        <div data-testid="data-child" />
      </ContentWrapper>,
    );

    expect(screen.getAllByTestId("data-child")).toHaveLength(1);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
