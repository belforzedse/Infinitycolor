import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import CheckoutTermsAcceptance from "./CheckoutTermsAcceptance";
import { RETURNS_PATH } from "@/constants/legal";

describe("CheckoutTermsAcceptance", () => {
  it("requires an unchecked consent checkbox with a policy link", () => {
    const onChange = jest.fn();
    render(<CheckoutTermsAcceptance checked={false} onChange={onChange} />);

    const checkbox = screen.getByTestId("checkout-accept-terms");
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAttribute("aria-required", "true");

    const termsLink = screen.getByRole("link", { name: "قوانین و مقررات سایت" });
    expect(termsLink).toHaveAttribute("href", RETURNS_PATH);
    expect(termsLink).toHaveAttribute("target", "_blank");
    expect(screen.getByText(/را خوانده‌ام و قبول دارم/)).toBeInTheDocument();
  });

  it("toggles consent without following the policy link", () => {
    const onChange = jest.fn();
    render(<CheckoutTermsAcceptance checked={false} onChange={onChange} />);

    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    expect(onChange).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("link", { name: "قوانین و مقررات سایت" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
