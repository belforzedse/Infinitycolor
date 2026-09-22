import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WalletHeaderBalance from "../WalletHeaderBalance";
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

describe("WalletHeaderBalance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps the wallet icon as a link without fetching for guests", () => {
    mockCurrentUser();
    render(<WalletHeaderBalance className="wallet-trigger" />);

    expect(screen.getByRole("link", { name: "کیف پول" })).toHaveAttribute("href", "/wallet");
    expect(getMyWallet).not.toHaveBeenCalled();
    expect(screen.queryByTestId("wallet-header-balance")).not.toBeInTheDocument();
  });

  it("loads the balance for signed-in shoppers so hover can show it", async () => {
    mockCurrentUser({ isAuthenticated: true });
    getMyWallet.mockResolvedValue({ success: true, data: { balance: 1_250_000 } });

    render(<WalletHeaderBalance className="wallet-trigger" />);

    expect(await screen.findByText(`${priceFormatter(125_000)} تومان`)).toBeInTheDocument();
    expect(getMyWallet).toHaveBeenCalledTimes(1);

    await userEvent.hover(screen.getByRole("link"));
    expect(screen.getByTestId("wallet-header-balance")).toHaveTextContent(
      `${priceFormatter(125_000)} تومان`,
    );
  });
});
