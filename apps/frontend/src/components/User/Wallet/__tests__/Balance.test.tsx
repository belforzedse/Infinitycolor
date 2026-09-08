import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import WalletBalance from "../Balance";

jest.mock("@/services/wallet", () => ({
  __esModule: true,
  default: { getMyWallet: jest.fn().mockResolvedValue({ success: true, data: { balance: 0 } }) },
}));

/**
 * "افزایش موجودی" carried no handler and no disabled state, so it looked live
 * and did nothing — the reported top-up defect. Top-up is currently switched
 * off site-wide, and the page's other entry point already said so; this control
 * has to agree with it rather than silently swallowing the click.
 */
describe("wallet increase-balance control", () => {
  it("is disabled while top-up is switched off", async () => {
    const onIncrease = jest.fn();
    render(<WalletBalance chargeDisabled onIncrease={onIncrease} />);

    const button = await screen.findByRole("button", { name: /افزایش موجودی/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-describedby", "wallet-charge-disabled-notice");

    await userEvent.click(button);
    expect(onIncrease).not.toHaveBeenCalled();
  });

  it("takes the customer to the top-up amounts when charging is enabled", async () => {
    const onIncrease = jest.fn();
    render(<WalletBalance chargeDisabled={false} onIncrease={onIncrease} />);

    const button = await screen.findByRole("button", { name: /افزایش موجودی/ });
    expect(button).toBeEnabled();

    await userEvent.click(button);
    expect(onIncrease).toHaveBeenCalledTimes(1);
  });
});
