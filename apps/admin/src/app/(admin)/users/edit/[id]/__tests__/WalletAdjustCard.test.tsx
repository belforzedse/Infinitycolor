import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WalletAdjustCard from "../WalletAdjustCard";
import { priceFormatter } from "@/utils/price";

const mockAdminGetUserWallet = jest.fn();
const mockAdminGetUserWalletHistory = jest.fn();
const mockAdminAdjustWallet = jest.fn();

jest.mock("@/services/wallet", () => ({
  __esModule: true,
  default: {
    adminGetUserWallet: (...args: unknown[]) => mockAdminGetUserWallet(...args),
    adminGetUserWalletHistory: (...args: unknown[]) => mockAdminGetUserWalletHistory(...args),
    adminAdjustWallet: (...args: unknown[]) => mockAdminAdjustWallet(...args),
  },
}));

jest.mock("react-hot-toast", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

/** Walks the operator through to the confirmation dialog for a debit. */
const requestDebit = async (amountToman: number) => {
  fireEvent.change(screen.getByLabelText(/نوع تغییر/), { target: { value: "debit" } });
  fireEvent.change(screen.getByLabelText(/مبلغ \(تومان\)/), {
    target: { value: String(amountToman) },
  });
  fireEvent.change(screen.getByLabelText(/دلیل تغییر/), { target: { value: "بازگشت وجه" } });
  fireEvent.click(screen.getByRole("button", { name: "اعمال تغییر" }));
};

describe("WalletAdjustCard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminGetUserWalletHistory.mockResolvedValue({ data: [] });
  });

  it("shows nothing but the balance when no credit is held", async () => {
    mockAdminGetUserWallet.mockResolvedValue({
      success: true,
      data: { balanceIrr: 5_000_000, balanceToman: 500_000, heldToman: 0, availableToman: 500_000 },
    });

    render(<WalletAdjustCard userId={7} />);

    await waitFor(() => expect(screen.getByTestId("wallet-balance")).toBeInTheDocument());
    expect(screen.queryByTestId("wallet-held")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wallet-available")).not.toBeInTheDocument();
  });

  it("separates held credit from what an adjustment can take", async () => {
    mockAdminGetUserWallet.mockResolvedValue({
      success: true,
      data: {
        balanceIrr: 5_000_000,
        balanceToman: 500_000,
        heldIrr: 3_500_000,
        heldToman: 350_000,
        availableIrr: 1_500_000,
        availableToman: 150_000,
      },
    });

    render(<WalletAdjustCard userId={7} />);

    await waitFor(() => expect(screen.getByTestId("wallet-held")).toBeInTheDocument());
    expect(screen.getByTestId("wallet-held")).toHaveTextContent(priceFormatter(350_000));
    expect(screen.getByTestId("wallet-available")).toHaveTextContent(priceFormatter(150_000));
  });

  it("refuses to submit a debit the server would reject for cutting into a hold", async () => {
    mockAdminGetUserWallet.mockResolvedValue({
      success: true,
      data: { balanceIrr: 5_000_000, balanceToman: 500_000, heldToman: 350_000, availableToman: 150_000 },
    });

    render(<WalletAdjustCard userId={7} />);
    await waitFor(() => expect(screen.getByTestId("wallet-held")).toBeInTheDocument());

    // 500,000 - 200,000 = 300,000, which is below the 350,000 that is held.
    await requestDebit(200_000);

    await waitFor(() => expect(screen.getByTestId("wallet-below-held")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "تأیید و اعمال" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "تأیید و اعمال" }));
    expect(mockAdminAdjustWallet).not.toHaveBeenCalled();
  });

  it("allows a debit that stays above the hold", async () => {
    mockAdminGetUserWallet.mockResolvedValue({
      success: true,
      data: { balanceIrr: 5_000_000, balanceToman: 500_000, heldToman: 350_000, availableToman: 150_000 },
    });
    mockAdminAdjustWallet.mockResolvedValue({
      success: true,
      data: { balanceIrr: 4_000_000, balanceToman: 400_000, heldToman: 350_000, availableToman: 50_000 },
    });

    render(<WalletAdjustCard userId={7} />);
    await waitFor(() => expect(screen.getByTestId("wallet-held")).toBeInTheDocument());

    await requestDebit(100_000);

    const confirm = await screen.findByRole("button", { name: "تأیید و اعمال" });
    expect(screen.queryByTestId("wallet-below-held")).not.toBeInTheDocument();
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(mockAdminAdjustWallet).toHaveBeenCalledWith(7, {
        mode: "debit",
        amountToman: 100_000,
        reason: "بازگشت وجه",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("wallet-balance")).toHaveTextContent(priceFormatter(400_000)));
  });
});
