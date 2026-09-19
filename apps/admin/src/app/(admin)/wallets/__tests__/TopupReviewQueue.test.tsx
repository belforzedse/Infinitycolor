import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TopupReviewQueue from "../TopupReviewQueue";

const mockGet = jest.fn();

jest.mock("@/services", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

const row = {
  id: 9,
  saleOrderId: "wallet-41-1758000000000-ab12",
  status: "Unknown",
  gateway: "Mellat",
  amountToman: 250_000,
  userId: 41,
  owner: "customer-41",
  providerReference: "REF-778",
  reconcileAttempts: 12,
  lastProviderCode: 21,
  lastProviderError: "invalid transaction",
  createdAt: "2026-09-18T09:00:00.000Z",
  updatedAt: "2026-09-19T09:00:00.000Z",
};

describe("TopupReviewQueue", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists what the reconciliation ladder gave up on", async () => {
    mockGet.mockResolvedValue({ data: { success: true, topups: [row] } });

    render(<TopupReviewQueue />);

    await waitFor(() => expect(screen.getAllByTestId("topup-review-row")).toHaveLength(1));
    expect(screen.getByText("wallet-41-1758000000000-ab12")).toBeInTheDocument();
    expect(screen.getByText("REF-778")).toBeInTheDocument();
    expect(screen.getByText("invalid transaction")).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith(
      "/wallet/topups/admin/review?limit=50",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("says so plainly when there is nothing stranded", async () => {
    mockGet.mockResolvedValue({ data: { success: true, topups: [] } });

    render(<TopupReviewQueue />);

    await waitFor(() => expect(screen.getByTestId("topup-review-empty")).toBeInTheDocument());
  });

  it("hands the operator to the wallet that has to be fixed", async () => {
    mockGet.mockResolvedValue({ data: { success: true, topups: [row] } });
    const onSelectOwner = jest.fn();

    render(<TopupReviewQueue onSelectOwner={onSelectOwner} />);

    fireEvent.click(await screen.findByRole("button", { name: "customer-41" }));
    expect(onSelectOwner).toHaveBeenCalledWith(41);
  });

  it("reports a failed load instead of showing an empty queue", async () => {
    mockGet.mockRejectedValue(new Error("boom"));

    render(<TopupReviewQueue />);

    await waitFor(() =>
      expect(screen.getByText(/دریافت فهرست شارژهای بلاتکلیف ناموفق بود/)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("topup-review-empty")).not.toBeInTheDocument();
  });
});
