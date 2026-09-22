import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import WalletContribution, {
  irrToToman,
  walletContributionToman,
} from "./WalletContribution";

const capabilities = {
  walletEnabled: true,
  splitEnabled: true,
  splitDisabledReason: null,
  splitGateways: ["mellat"],
  gatewayMinimumsToman: { mellat: 1000 },
} as any;

const setup = (overrides: Partial<React.ComponentProps<typeof WalletContribution>> = {}) => {
  const onEnabledChange = jest.fn();
  render(
    <WalletContribution
      totalToman={1_200_000}
      availableIrr={5_000_000}
      heldIrr={0}
      capabilities={capabilities}
      enabled
      onEnabledChange={onEnabledChange}
      {...overrides}
    />,
  );
  return { onEnabledChange };
};

describe("WalletContribution", () => {
  it("never rounds a fractional legacy balance up into spendable credit", () => {
    // 1,239 rial is 123.9 toman. Offering 124 would promise a rial the store
    // does not hold, and the server floors too.
    expect(irrToToman(1_239)).toBe(123);
    expect(irrToToman(0)).toBe(0);
    expect(irrToToman(-500)).toBe(0);
  });

  it("spends as much of the order as the shopper has, and no more", () => {
    // Credit is the smaller of the two, so it covers part of the order.
    expect(walletContributionToman(3_500_000, 1_200_000)).toBe(350_000);
    // The order is the smaller of the two, so the rest of the credit is left.
    expect(walletContributionToman(50_000_000, 1_200_000)).toBe(1_200_000);
    expect(walletContributionToman(0, 1_200_000)).toBe(0);
  });

  it("shows the split without changing the order total", () => {
    setup({ availableIrr: 3_500_000 });

    expect(screen.getByTestId("wallet-contribution-wallet-leg")).toHaveTextContent("۳۵۰٬۰۰۰");
    expect(screen.getByTestId("wallet-contribution-gateway-leg")).toHaveTextContent("۸۵۰٬۰۰۰");
    // Wallet credit is a tender, not a discount.
    expect(screen.getByTestId("wallet-contribution-summary")).toHaveTextContent("۱٬۲۰۰٬۰۰۰");
  });

  it("reports held credit separately from what is spendable", () => {
    setup({ availableIrr: 1_500_000, heldIrr: 3_500_000 });

    expect(screen.getByTestId("wallet-contribution-available")).toHaveTextContent("۱۵۰٬۰۰۰");
    expect(screen.getByTestId("wallet-contribution-held")).toHaveTextContent("۳۵۰٬۰۰۰");
    // Only what is spendable is offered to this order.
    expect(screen.getByTestId("wallet-contribution-wallet-leg")).toHaveTextContent("۱۵۰٬۰۰۰");
  });

  it("shows no split at all until the shopper ticks the box", () => {
    setup({ enabled: false });

    expect(screen.getByTestId("wallet-contribution-toggle")).not.toBeChecked();
    expect(screen.queryByTestId("wallet-contribution-summary")).not.toBeInTheDocument();
    // The balance is still worth seeing before deciding.
    expect(screen.getByTestId("wallet-contribution-available")).toHaveTextContent("۵۰۰٬۰۰۰");
  });

  it("reports the shopper's choice rather than acting on it itself", () => {
    const { onEnabledChange } = setup({ enabled: false });

    fireEvent.click(screen.getByTestId("wallet-contribution-toggle"));

    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it("says so when credit covers the whole order", () => {
    setup({ totalToman: 500_000, availableIrr: 5_000_000 });

    expect(screen.getByTestId("wallet-contribution-wallet-leg")).toHaveTextContent("۵۰۰٬۰۰۰");
    expect(screen.getByTestId("wallet-contribution-gateway-leg")).toHaveTextContent("۰");
    expect(screen.getByText(/نیازی به درگاه بانکی نیست/)).toBeInTheDocument();
  });

  it("explains a disabled split instead of silently dropping the option", () => {
    setup({
      availableIrr: 3_500_000,
      capabilities: { ...capabilities, splitEnabled: false, splitDisabledReason: "disabled" },
    });

    expect(screen.getByTestId("wallet-contribution-split-refused")).toBeInTheDocument();
  });

  it("does not claim a split is refused when credit covers the whole order", () => {
    // Nothing is left for a gateway, so the split rule does not apply.
    setup({
      totalToman: 500_000,
      availableIrr: 5_000_000,
      capabilities: { ...capabilities, splitEnabled: false, splitDisabledReason: "disabled" },
    });

    expect(screen.queryByTestId("wallet-contribution-split-refused")).not.toBeInTheDocument();
  });

  it("renders nothing when the wallet is unavailable or empty", () => {
    const { container } = render(
      <WalletContribution
        totalToman={1_200_000}
        availableIrr={0}
        heldIrr={0}
        capabilities={capabilities}
        enabled={false}
        onEnabledChange={jest.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("credit committed to an unfinished payment", () => {
  const heldOnly = (heldIrr: number, boundAt: string | null = "2026-09-20T11:30:00.000Z") =>
    render(
      <WalletContribution
        totalToman={1_200_000}
        availableIrr={0}
        heldIrr={heldIrr}
        holds={[
          {
            attemptId: "attempt-1",
            paymentAttemptId: 11,
            orderId: 22,
            gateway: "snappay",
            amountIrr: heldIrr,
            heldAt: "2026-09-20T10:00:00.000Z",
            state: "reconciling",
            nextCheckAt: null,
            boundAt,
          },
        ]}
        capabilities={capabilities}
        enabled
        onEnabledChange={jest.fn()}
      />,
    );

  it("explains the held credit instead of vanishing when nothing is spendable", () => {
    // This is the worst moment of the defect: the shopper's money is tied up in
    // a checkout they abandoned, and the card that would explain it disappears
    // precisely because the spendable balance reads zero.
    heldOnly(3_000_000);
    const notice = screen.getByTestId("wallet-contribution-held-only");
    expect(notice).toHaveTextContent("رزرو شده");
    expect(notice).toHaveTextContent("به‌طور خودکار آزاد می‌شود");
  });

  it("still renders nothing when there is neither spendable nor held credit", () => {
    render(
      <WalletContribution
        totalToman={1_200_000}
        availableIrr={0}
        heldIrr={0}
        capabilities={capabilities}
        enabled
        onEnabledChange={jest.fn()}
      />,
    );
    expect(screen.queryByTestId("wallet-contribution-held-only")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wallet-contribution")).not.toBeInTheDocument();
  });

  it("keeps the ordinary card when some credit is still spendable", () => {
    render(
      <WalletContribution
        totalToman={1_200_000}
        availableIrr={5_000_000}
        heldIrr={3_000_000}
        capabilities={capabilities}
        enabled
        onEnabledChange={jest.fn()}
      />,
    );
    expect(screen.getByTestId("wallet-contribution")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-contribution-held")).toBeInTheDocument();
  });
});
