import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ShoppingCartBillPaymentGateway from "./PaymentGateway";

describe("ShoppingCartBillPaymentGateway", () => {
  const onChange = jest.fn();

  beforeEach(() => {
    onChange.mockReset();
  });

  it("renders only available gateway options", () => {
    render(
      <ShoppingCartBillPaymentGateway
        selected="samankish"
        onChange={onChange}
        availableGateways={["samankish", "mellat", "snappay", "zarinpal", "wallet"]}
        snappEligible={true}
      />,
    );

    expect(screen.getByTestId("payment-gateway-samankish")).toBeInTheDocument();
    expect(screen.getByTestId("payment-gateway-mellat")).toBeInTheDocument();
    expect(screen.getByTestId("payment-gateway-snappay")).toBeInTheDocument();
    expect(screen.getByTestId("payment-gateway-zarinpal")).toBeInTheDocument();
    // The wallet is a tender the shopper ticks above the gateways, not a bank
    // to pick between. Offering it here made them look mutually exclusive.
    expect(screen.queryByTestId("payment-gateway-wallet")).not.toBeInTheDocument();
  });

  it("hides excluded gateways", () => {
    render(
      <ShoppingCartBillPaymentGateway
        selected="samankish"
        onChange={onChange}
        availableGateways={["samankish", "wallet"]}
      />,
    );

    expect(screen.getByTestId("payment-gateway-samankish")).toBeInTheDocument();
    expect(screen.queryByTestId("payment-gateway-wallet")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-gateway-mellat")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-gateway-snappay")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-gateway-zarinpal")).not.toBeInTheDocument();
  });

  it("hides SnappPay when user is not eligible", () => {
    render(
      <ShoppingCartBillPaymentGateway
        selected="samankish"
        onChange={onChange}
        availableGateways={["samankish", "snappay"]}
        snappEligible={false}
      />,
    );

    expect(screen.queryByTestId("payment-gateway-snappay")).not.toBeInTheDocument();
  });

  it("says why SnappPay is gone when a wallet split excludes it", () => {
    // Hiding the card on its own reads as a glitch. The shopper has to be told
    // the wallet tick is what removed it, since unticking brings it back.
    render(
      <ShoppingCartBillPaymentGateway
        selected="samankish"
        onChange={onChange}
        availableGateways={["samankish", "snappay"]}
        snappEligible={false}
        snappBlockedByWalletSplit
      />,
    );

    expect(screen.queryByTestId("payment-gateway-snappay")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("payment-gateway-snappay-wallet-blocked"),
    ).toBeInTheDocument();
  });

  it("stays silent about SnappPay when the store never offered it", () => {
    render(
      <ShoppingCartBillPaymentGateway
        selected="samankish"
        onChange={onChange}
        availableGateways={["samankish"]}
        snappEligible={false}
        snappBlockedByWalletSplit
      />,
    );

    expect(
      screen.queryByTestId("payment-gateway-snappay-wallet-blocked"),
    ).not.toBeInTheDocument();
  });

  it("renders SnappPay disabled before eligibility is known", () => {
    render(
      <ShoppingCartBillPaymentGateway
        selected="samankish"
        onChange={onChange}
        availableGateways={["samankish", "snappay"]}
      />,
    );

    expect(screen.getByTestId("payment-gateway-snappay")).toBeDisabled();
  });

  it("renders the provider title first and preserves the description as the secondary line", () => {
    render(
      <ShoppingCartBillPaymentGateway
        selected="snappay"
        onChange={onChange}
        availableGateways={["snappay"]}
        snappEligible
        snappTitle="  پرداخت اعتباری اسنپ پی  "
        snappDescription="  تا سقف اعتبار قابل استفاده  "
      />,
    );

    const title = screen.getByText("پرداخت اعتباری اسنپ پی");
    const description = screen.getByText("تا سقف اعتبار قابل استفاده");

    expect(title.parentElement).toBe(description.parentElement);
    expect(Array.from(title.parentElement?.children || [])).toEqual([title, description]);
    expect(screen.queryByText("اسنپ پی")).not.toBeInTheDocument();
  });

  it("falls back to the default SnappPay title until a provider title is received", () => {
    render(
      <ShoppingCartBillPaymentGateway
        selected="snappay"
        onChange={onChange}
        availableGateways={["snappay"]}
        snappEligible
        snappTitle=" "
        snappDescription="تا سقف اعتبار قابل استفاده"
      />,
    );

    const gateway = screen.getByTestId("payment-gateway-snappay");
    expect(screen.getByText("اسنپ پی")).toBeInTheDocument();
    expect(screen.getByText("تا سقف اعتبار قابل استفاده")).toBeInTheDocument();
    expect(gateway).toHaveAccessibleName(/اسنپ پی/);
  });

  it("renders no gateway cards when availableGateways is omitted", () => {
    expect(() => {
      render(<ShoppingCartBillPaymentGateway selected="samankish" onChange={onChange} />);
    }).not.toThrow();

    expect(screen.queryByTestId("payment-gateway-samankish")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-gateway-mellat")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-gateway-wallet")).not.toBeInTheDocument();
  });

  it("selects ZarinPal when the user clicks its gateway option", async () => {
    const user = userEvent.setup();
    render(
      <ShoppingCartBillPaymentGateway
        selected="samankish"
        onChange={onChange}
        availableGateways={["samankish", "zarinpal"]}
      />,
    );

    expect(screen.getByTestId("payment-gateway-zarinpal")).toHaveAttribute(
      "data-selected",
      "false",
    );

    await user.click(screen.getByTestId("payment-gateway-zarinpal"));

    expect(onChange).toHaveBeenCalledWith("zarinpal");
  });

  // The code a card reports is the gateway the payment request goes to, so a
  // swapped mapping would send the shopper to the wrong bank.
  it.each([
    ["samankish", "payment-gateway-samankish"],
    ["mellat", "payment-gateway-mellat"],
  ] as const)("selects %s when the user clicks its card", async (gateway, testId) => {
    const user = userEvent.setup();
    render(
      <ShoppingCartBillPaymentGateway
        selected="zarinpal"
        onChange={onChange}
        availableGateways={["samankish", "mellat", "zarinpal"]}
      />,
    );

    await user.click(screen.getByTestId(testId));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(gateway);
  });

  it("selects SnappPay once the shopper is eligible", async () => {
    const user = userEvent.setup();
    render(
      <ShoppingCartBillPaymentGateway
        selected="samankish"
        onChange={onChange}
        availableGateways={["samankish", "snappay"]}
        snappEligible
      />,
    );

    await user.click(screen.getByTestId("payment-gateway-snappay"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("snappay");
  });

  it("ignores a SnappPay click before eligibility is known", async () => {
    const user = userEvent.setup();
    render(
      <ShoppingCartBillPaymentGateway
        selected="samankish"
        onChange={onChange}
        availableGateways={["samankish", "snappay"]}
      />,
    );

    await user.click(screen.getByTestId("payment-gateway-snappay"));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("marks the selected ZarinPal option", () => {
    render(
      <ShoppingCartBillPaymentGateway
        selected="zarinpal"
        onChange={onChange}
        availableGateways={["samankish", "zarinpal"]}
      />,
    );

    expect(screen.getByTestId("payment-gateway-zarinpal")).toHaveAttribute(
      "data-selected",
      "true",
    );
  });

  it("offers no bank at all once credit covers the whole order", () => {
    render(
      <ShoppingCartBillPaymentGateway
        selected="samankish"
        onChange={onChange}
        availableGateways={["samankish", "mellat", "zarinpal"]}
        walletCoversTotal
      />,
    );

    // Nothing is left for a bank to carry, so a choice here would have no
    // effect. The shopper is told why rather than shown a dead list.
    expect(screen.getByTestId("payment-gateway-wallet-only")).toBeInTheDocument();
    expect(screen.queryByTestId("payment-gateway-samankish")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-gateway-mellat")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-gateway-zarinpal")).not.toBeInTheDocument();
  });
});
