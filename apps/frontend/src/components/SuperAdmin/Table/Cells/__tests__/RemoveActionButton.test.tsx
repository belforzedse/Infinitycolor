import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RemoveActionButton from "../RemoveActionButton";

const put = jest.fn().mockResolvedValue({});
const del = jest.fn().mockResolvedValue({});

jest.mock("@/services", () => ({
  apiClient: {
    put: (...args: unknown[]) => put(...args),
    delete: (...args: unknown[]) => del(...args),
  },
}));

jest.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ isStoreManager: false }),
}));

// RemoveActionButton imports `refreshTable` from "..", which from the component
// resolves to src/components/SuperAdmin/Table/index — i.e. "../.." from here.
jest.mock("../..", () => {
  const { atom } = require("jotai");
  return { refreshTable: atom(false) };
});

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

describe("RemoveActionButton restore confirmation", () => {
  beforeEach(() => jest.clearAllMocks());

  const baseProps = {
    isRemoved: true,
    id: "42",
    apiUrl: "/products",
    itemName: "محصول",
    testIdPrefix: "product",
  };

  it("does not restore immediately — it asks for confirmation first", () => {
    render(<RemoveActionButton {...baseProps} />);
    fireEvent.click(screen.getByTestId("product-restore"));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText("بازیابی")).toBeInTheDocument();
  });

  it("restores with removedAt:null only after confirming", async () => {
    render(<RemoveActionButton {...baseProps} />);
    fireEvent.click(screen.getByTestId("product-restore"));
    fireEvent.click(screen.getByText("بله، بازیابی کن"));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/products/42", { data: { removedAt: null } });
  });

  it("does not restore when the confirmation is cancelled", () => {
    render(<RemoveActionButton {...baseProps} />);
    fireEvent.click(screen.getByTestId("product-restore"));
    fireEvent.click(screen.getByText("انصراف"));
    expect(put).not.toHaveBeenCalled();
  });
});
