import React from "react";
import { act, render, screen } from "@testing-library/react";
import ShoppingCartBillDeliveryForm from "./DeliveryForm";

// Render and flush the async shipping-methods fetch so state updates are wrapped.
async function renderForm(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

jest.mock("@/contexts/CartContext", () => ({
  useCart: () => ({
    totalPrice: 100_000,
    totalItems: 2,
    subtotalBeforeDiscount: 100_000,
    cartDiscountTotal: 0,
    openDrawer: jest.fn(),
  }),
}));

jest.mock("@/services/shipping", () => ({
  getAvailableShippingOptions: jest.fn().mockResolvedValue([]),
}));

jest.mock("./DeliveryOptions", () => ({
  __esModule: true,
  default: () => <div data-testid="delivery-options" />,
}));

const preview = {
  discount: 5000,
  summary: {
    subtotal: 100_000,
    eligibleSubtotal: 100_000,
    tax: 0,
    shipping: 0,
    total: 95_000,
    taxPercent: 0,
  },
};

const baseProps = {
  control: {} as never,
  setValue: jest.fn() as never,
  selectedShipping: null,
};

describe("ShoppingCartBillDeliveryForm discount + loading states", () => {
  it("labels the discount line with the applied code", async () => {
    await renderForm(
      <ShoppingCartBillDeliveryForm
        {...baseProps}
        discountPreview={preview}
        discountCode="SUMMER"
      />,
    );
    expect(screen.getByText("(SUMMER)")).toBeInTheDocument();
  });

  it("shows a calculating indicator instead of the total while previewLoading", async () => {
    await renderForm(
      <ShoppingCartBillDeliveryForm
        {...baseProps}
        discountPreview={preview}
        discountCode="SUMMER"
        previewLoading
      />,
    );
    expect(screen.getByTestId("checkout-total-loading")).toBeInTheDocument();
  });

  it("shows the payable total when not loading", async () => {
    await renderForm(
      <ShoppingCartBillDeliveryForm {...baseProps} discountPreview={preview} discountCode="SUMMER" />,
    );
    expect(screen.queryByTestId("checkout-total-loading")).not.toBeInTheDocument();
  });
});
