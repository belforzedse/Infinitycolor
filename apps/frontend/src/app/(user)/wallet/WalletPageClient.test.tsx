import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WalletService from "@/services/wallet";
import WalletPage from "./WalletPageClient";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn() }),
}));

jest.mock("@/services/wallet", () => {
  const { splitWalletLedger } = jest.requireActual("@/services/wallet/ledger") as {
    splitWalletLedger: (entries: unknown[]) => {
      deposits: unknown[];
      purchases: unknown[];
    };
  };
  return {
    __esModule: true,
    splitWalletLedger,
    default: {
      getTopupOptions: jest.fn(),
      getTopupStatus: jest.fn(),
      getMyWallet: jest.fn(),
      getMyWalletTransactions: jest.fn(),
      getWalletTransactions: jest.fn(),
    },
  };
});

jest.mock("@/components/layout/UserContainer", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock("@/components/storefront/StorefrontAccountShell", () => ({
  StorefrontAccountShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock("@/components/User/Account/QuickLinks", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@/components/User/Wallet/TransactionsList", () => ({
  __esModule: true,
  default: ({
    depositList,
    purchaseList,
  }: {
    depositList: Array<{ amountToman: number }>;
    purchaseList: Array<{ amountToman: number }>;
  }) => (
    <div>
      <div data-testid="wallet-deposits">{depositList.length}</div>
      <div data-testid="wallet-purchases">{purchaseList.length}</div>
    </div>
  ),
}));

jest.mock("@/components/User/Icons/TransactionsIcon", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@/components/User/Wallet/Balance", () => ({
  __esModule: true,
  default: () => <div data-testid="wallet-balance-card">balance</div>,
}));

jest.mock("@/components/User/Wallet/IncreaseBalance", () => ({
  __esModule: true,
  default: ({ options, loading }: { options: unknown; loading: boolean }) => (
    <button data-testid="wallet-topup-form" disabled={!options || loading}>
      top up
    </button>
  ),
}));

describe("WalletPage storefront top-up switch", () => {
  const originalValue = process.env.NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED;

  afterEach(() => {
    jest.clearAllMocks();
    if (originalValue === undefined) {
      delete process.env.NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED = originalValue;
    }
  });

  it("keeps every top-up action disabled without contacting the options endpoint", async () => {
    delete process.env.NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED;

    render(<WalletPage />);

    expect(screen.getByText("در حال حاضر امکان شارژ کیف پول وجود ندارد.")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-topup-form")).toBeDisabled();
    await waitFor(() => expect(WalletService.getTopupOptions).not.toHaveBeenCalled());
  });

  it("shows both deposits and purchases from the owner ledger", async () => {
    process.env.NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED = "false";
    (WalletService.getMyWalletTransactions as jest.Mock).mockResolvedValue([
      { id: 1, amountIrr: 1_000_000, type: "Add", date: "2026-09-18T10:00:00.000Z" },
      { id: 2, amountIrr: 250_000, type: "Minus", date: "2026-09-19T10:00:00.000Z" },
    ]);

    render(<WalletPage />);
    fireEvent.click(screen.getByRole("button", { name: "مشاهده سوابق تراکنش" }));

    await waitFor(() => expect(WalletService.getMyWalletTransactions).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("wallet-deposits")).toHaveTextContent("1");
    expect(screen.getByTestId("wallet-purchases")).toHaveTextContent("1");
  });
});
