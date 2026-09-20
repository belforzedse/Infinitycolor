import { render, screen, waitFor } from "@testing-library/react";
import MobileWalletBalance from "../MobileWalletBalance";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import WalletService from "@/services/wallet";
import { priceFormatter } from "@/utils/price";

jest.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: jest.fn(),
}));

jest.mock("@/services/wallet", () => ({
  __esModule: true,
  default: { getMyWallet: jest.fn() },
}));

const mockedUseCurrentUser = useCurrentUser as jest.MockedFunction<typeof useCurrentUser>;
const getMyWallet = WalletService.getMyWallet as jest.MockedFunction<typeof WalletService.getMyWallet>;

const mockCurrentUser = (overrides: Partial<ReturnType<typeof useCurrentUser>> = {}) => {
  mockedUseCurrentUser.mockReturnValue({
    user: null,
    isLoading: false,
    error: null,
    isAuthenticated: false,
    isAdmin: false,
    roleName: null,
    isStoreManager: false,
    isFounder: false,
    ...overrides,
  });
};

describe("MobileWalletBalance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not fetch until the menu is open for a signed-in shopper", () => {
    mockCurrentUser({ isAuthenticated: true });
    render(<MobileWalletBalance isOpen={false} onNavigate={jest.fn()} />);

    expect(getMyWallet).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-menu-wallet-balance")).toHaveTextContent("کیف پول");
  });

  it("shows the wallet balance when the menu opens", async () => {
    mockCurrentUser({ isAuthenticated: true });
    getMyWallet.mockResolvedValue({ success: true, data: { balance: 2_000_000 } });

    render(<MobileWalletBalance isOpen onNavigate={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("mobile-menu-wallet-balance")).toHaveTextContent(
        `${priceFormatter(200_000)} تومان`,
      ),
    );
    expect(screen.getByTestId("mobile-menu-wallet-balance")).toHaveAttribute("href", "/wallet");
  });
});
