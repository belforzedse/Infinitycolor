import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { priceFormatter } from "@/utils/price";
import WalletContribution, { irrToToman, parseWalletAmount } from "./WalletContribution";

/** The card renders Persian digits, so expectations are formatted the same way. */
const fa = (value: number) => priceFormatter(value);

const capabilities = (over: Partial<Parameters<typeof WalletContribution>[0]["capabilities"] & object> = {}) => ({
  walletEnabled: true,
  splitEnabled: true,
  splitDisabledReason: null,
  splitGateways: ["mellat", "samankish", "zarinpal"],
  gatewayMinimumsToman: { mellat: 1000 },
  ...over,
}) as NonNullable<Parameters<typeof WalletContribution>[0]["capabilities"]>;

function setup(over: Partial<Parameters<typeof WalletContribution>[0]> = {}) {
  const onEnabledChange = jest.fn();
  const onAmountTextChange = jest.fn();
  const props = {
    totalToman: 1_200_000,
    availableIrr: 5_000_000,
    heldIrr: 0,
    capabilities: capabilities(),
    enabled: true,
    onEnabledChange,
    amountText: "350000",
    onAmountTextChange,
    ...over,
  };
  render(<WalletContribution {...props} />);
  return { onEnabledChange, onAmountTextChange };
}

describe("wallet amount parsing", () => {
  it("accepts Persian and Arabic-Indic digits with separators", () => {
    expect(parseWalletAmount("۳۵۰٬۰۰۰")).toBe(350_000);
    expect(parseWalletAmount("٣٥٠,٠٠٠")).toBe(350_000);
  });

  it("refuses anything that is not purely a number", () => {
    for (const bad of ["12a3", "1.5", "-5", ""]) {
      expect(parseWalletAmount(bad)).toBeNull();
    }
  });

  it("never rounds a fractional legacy balance up into spendable credit", () => {
    expect(irrToToman(10_005)).toBe(1_000);
    expect(irrToToman(9)).toBe(0);
  });
});

describe("WalletContribution", () => {
  it("shows the split without changing the order total", () => {
    setup();

    expect(screen.getByTestId("wallet-contribution-wallet-leg")).toHaveTextContent(fa(350_000));
    expect(screen.getByTestId("wallet-contribution-gateway-leg")).toHaveTextContent(fa(850_000));
  });

  it("reports held credit separately from what is spendable", () => {
    setup({ availableIrr: 1_500_000, heldIrr: 3_500_000, amountText: "150000" });

    expect(
      screen.getByText(new RegExp(`موجودی قابل استفاده: ${fa(150_000)} تومان`)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`${fa(350_000)} تومان برای یک پرداخت در حال انجام رزرو شده است`)),
    ).toBeInTheDocument();
  });

  it("refuses an amount beyond what is spendable", () => {
    setup({ availableIrr: 1_000_000, amountText: "350000" });

    expect(screen.getByTestId("wallet-contribution-error")).toHaveTextContent(
      "موجودی قابل استفاده کیف پول کافی نیست. مبلغ را تغییر دهید.",
    );
    // Nothing is attributed to the wallet while the amount is invalid.
    expect(screen.getByTestId("wallet-contribution-wallet-leg")).toHaveTextContent(fa(0));
    expect(screen.getByTestId("wallet-contribution-gateway-leg")).toHaveTextContent(fa(1_200_000));
  });

  it("fills in the largest usable amount on request", () => {
    const { onAmountTextChange } = setup({ availableIrr: 5_000_000 });

    fireEvent.click(screen.getByTestId("wallet-contribution-max"));

    // Capped by the order total as well as by the balance.
    expect(onAmountTextChange).toHaveBeenCalledWith("500000");
  });

  it("says so when credit covers the whole order", () => {
    setup({ totalToman: 500_000, availableIrr: 5_000_000, amountText: "500000" });

    expect(
      screen.getByText(/کل مبلغ سفارش را پوشش می‌دهد/),
    ).toBeInTheDocument();
  });

  it("explains a disabled split instead of silently dropping the option", () => {
    setup({
      capabilities: capabilities({ splitEnabled: false, splitGateways: [] }),
    });

    expect(
      screen.getByText(/پرداخت ترکیبی کیف پول و درگاه در حال حاضر فعال نیست/),
    ).toBeInTheDocument();
  });

  it("renders nothing when the wallet is unavailable or empty", () => {
    const { container } = render(
      <WalletContribution
        totalToman={1_200_000}
        availableIrr={0}
        heldIrr={0}
        capabilities={capabilities()}
        enabled={false}
        onEnabledChange={jest.fn()}
        amountText=""
        onAmountTextChange={jest.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
