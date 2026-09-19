import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import WalletService from "@/services/wallet";
import WalletPage from "./WalletPageClient";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn() }),
}));

jest.mock("@/services/wallet", () => ({
  __esModule: true,
  default: {
    getTopupOptions: jest.fn(),
    getTopupStatus: jest.fn(),
    getMyWallet: jest.fn(),
    getWalletTransactions: jest.fn(),
  },
}));

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
  default: () => null,
}));

jest.mock("@/components/User/Icons/TransactionsIcon", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@/components/User/Wallet/Balance", () => ({
  __esModule: true,
  default: ({ chargeDisabled }: { chargeDisabled: boolean }) => (
    <button data-testid="wallet-balance-increase" disabled={chargeDisabled}>
      increase
    </button>
  ),
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
    expect(screen.getByTestId("wallet-balance-increase")).toBeDisabled();
    expect(screen.getByTestId("wallet-topup-form")).toBeDisabled();
    await waitFor(() => expect(WalletService.getTopupOptions).not.toHaveBeenCalled());
  });
});
