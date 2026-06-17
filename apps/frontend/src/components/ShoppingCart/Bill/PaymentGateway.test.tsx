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
    expect(screen.getByTestId("payment-gateway-wallet")).toBeInTheDocument();
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
    expect(screen.getByTestId("payment-gateway-wallet")).toBeInTheDocument();
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

  it("does not select wallet when balance is insufficient", async () => {
    const user = userEvent.setup();
    render(
      <ShoppingCartBillPaymentGateway
        selected="samankish"
        onChange={onChange}
        availableGateways={["samankish", "wallet"]}
        walletBalanceIrr={5_000}
        requiredAmountIrr={10_000}
      />,
    );

    const wallet = screen.getByTestId("payment-gateway-wallet");
    expect(wallet).toHaveAttribute("data-disabled", "true");

    await user.click(wallet);

    expect(onChange).not.toHaveBeenCalled();
  });
});
