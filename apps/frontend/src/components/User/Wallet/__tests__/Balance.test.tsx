import { render, screen } from "@testing-library/react";
import WalletBalance from "../Balance";

jest.mock("@/services/wallet", () => ({
  __esModule: true,
  default: { getMyWallet: jest.fn().mockResolvedValue({ success: true, data: { balance: 0 } }) },
}));

describe("wallet balance card", () => {
  it("does not offer a second increase-balance control next to the card", async () => {
    render(<WalletBalance />);

    expect(await screen.findByText("کیف پول اینفینیتی")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /افزایش موجودی/ })).not.toBeInTheDocument();
  });
});
