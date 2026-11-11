import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import ShoppingCartBillDeliveryForm from "./DeliveryForm";
import { getAvailableShippingOptions } from "@/services/shipping";

// Render and flush the async shipping-methods fetch so state updates are wrapped.
async function renderForm(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

let mockCartState = {
  totalPrice: 100_000,
  totalItems: 2,
  subtotalBeforeDiscount: 100_000,
  cartDiscountTotal: 0,
  cartItems: [
    {
      id: "1",
      cartItemId: "10",
      variationId: "100",
      quantity: 2,
      price: 50_000,
    },
  ],
};

jest.mock("@/contexts/CartContext", () => ({
  useCart: () => ({
    ...mockCartState,
    openDrawer: jest.fn(),
  }),
}));

jest.mock("@/services/shipping", () => ({
  getAvailableShippingOptions: jest.fn().mockResolvedValue([]),
}));

const mockedGetAvailableShippingOptions = getAvailableShippingOptions as jest.MockedFunction<
  typeof getAvailableShippingOptions
>;

const resetCartState = () => {
  mockCartState = {
    totalPrice: 100_000,
    totalItems: 2,
    subtotalBeforeDiscount: 100_000,
    cartDiscountTotal: 0,
    cartItems: [
      {
        id: "1",
        cartItemId: "10",
        variationId: "100",
        quantity: 2,
        price: 50_000,
      },
    ],
  };
};

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
  beforeEach(() => {
    resetCartState();
    mockedGetAvailableShippingOptions.mockClear();
    mockedGetAvailableShippingOptions.mockResolvedValue([]);
  });

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

  /**
   * Wallet credit is spent against the order, so the totals have to show where it
   * went. Before this, "قابل پرداخت" repeated the order total while the wallet card
   * above it said the gateway leg was zero.
   */
  it("deducts the wallet and makes قابل پرداخت the gateway amount", async () => {
    await renderForm(
      <ShoppingCartBillDeliveryForm {...baseProps} discountPreview={preview} walletToman={40_000} />,
    );

    expect(screen.getByTestId("checkout-wallet-deduction")).toHaveTextContent("-40,000 تومان");
    // 95,000 order total less 40,000 of credit.
    expect(screen.getByTestId("checkout-payable-total")).toHaveTextContent("55,000 تومان");
  });

  it("shows nothing payable when the wallet covers the whole order", async () => {
    await renderForm(
      <ShoppingCartBillDeliveryForm {...baseProps} discountPreview={preview} walletToman={95_000} />,
    );

    expect(screen.getByTestId("checkout-payable-total")).toHaveTextContent("0 تومان");
  });

  it("never shows a negative payable when the credit figure outruns the total", async () => {
    await renderForm(
      <ShoppingCartBillDeliveryForm {...baseProps} discountPreview={preview} walletToman={500_000} />,
    );

    expect(screen.getByTestId("checkout-wallet-deduction")).toHaveTextContent("-95,000 تومان");
    expect(screen.getByTestId("checkout-payable-total")).toHaveTextContent("0 تومان");
  });

  it("leaves the totals untouched when no wallet credit is applied", async () => {
    await renderForm(<ShoppingCartBillDeliveryForm {...baseProps} discountPreview={preview} />);

    expect(screen.queryByTestId("checkout-wallet-deduction")).not.toBeInTheDocument();
    expect(screen.getByTestId("checkout-payable-total")).toHaveTextContent("95,000 تومان");
  });

  it("does not refetch shipping options when only the selected method changes", async () => {
    const addressContext = { addressId: 44 };
    mockedGetAvailableShippingOptions.mockResolvedValue([
      {
        id: 1,
        code: "post",
        title: "Post",
        price: 10_000,
        basePrice: 10_000,
        sortOrder: 1,
      },
    ]);

    const { rerender } = render(
      <ShoppingCartBillDeliveryForm
        {...baseProps}
        addressContext={addressContext}
      />,
    );

    await waitFor(() => {
      expect(mockedGetAvailableShippingOptions).toHaveBeenCalledTimes(1);
    });

    rerender(
      <ShoppingCartBillDeliveryForm
        {...baseProps}
        addressContext={addressContext}
        selectedShipping={{
          id: 1,
          code: "post",
          title: "Post",
          price: 10_000,
          basePrice: 10_000,
          sortOrder: 1,
        }}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedGetAvailableShippingOptions).toHaveBeenCalledTimes(1);
  });

  it("refetches shipping options when the cart signature changes", async () => {
    const addressContext = { addressId: 44 };
    const { rerender } = render(
      <ShoppingCartBillDeliveryForm
        {...baseProps}
        addressContext={addressContext}
      />,
    );

    await waitFor(() => {
      expect(mockedGetAvailableShippingOptions).toHaveBeenCalledTimes(1);
    });

    mockCartState = {
      ...mockCartState,
      totalPrice: 150_000,
      cartItems: [
        {
          ...mockCartState.cartItems[0],
          quantity: 3,
        },
      ],
    };

    rerender(
      <ShoppingCartBillDeliveryForm
        {...baseProps}
        addressContext={addressContext}
      />,
    );

    await waitFor(() => {
      expect(mockedGetAvailableShippingOptions).toHaveBeenCalledTimes(2);
    });
  });
});

describe("ShoppingCartBillDeliveryForm with a Bale shipping choice", () => {
  beforeEach(() => {
    resetCartState();
    mockedGetAvailableShippingOptions.mockReset();
  });

  it("selects the method the shopper chose in Bale once the address offers it", async () => {
    const pishtaz = { id: 7, title: "پیشتاز", price: 45_000 } as never;
    mockedGetAvailableShippingOptions.mockResolvedValue([
      { id: 3, title: "تیپاکس", price: 60_000 } as never,
      pishtaz,
    ]);
    const setValue = jest.fn();
    await renderForm(
      <ShoppingCartBillDeliveryForm
        {...baseProps}
        setValue={setValue as never}
        addressContext={{ addressPayload: { shipping_city: 12 } }}
        preferredShippingId={7}
      />,
    );
    await waitFor(() => expect(setValue).toHaveBeenCalledWith("shippingMethod", pishtaz));
  });

  it("leaves the choice to the shopper when Bale's method is not offered", async () => {
    mockedGetAvailableShippingOptions.mockResolvedValue([{ id: 3, title: "تیپاکس", price: 60_000 } as never]);
    const setValue = jest.fn();
    await renderForm(
      <ShoppingCartBillDeliveryForm
        {...baseProps}
        setValue={setValue as never}
        addressContext={{ addressPayload: { shipping_city: 12 } }}
        preferredShippingId={7}
      />,
    );
    await waitFor(() => expect(mockedGetAvailableShippingOptions).toHaveBeenCalled());
    expect(setValue).not.toHaveBeenCalledWith("shippingMethod", expect.objectContaining({ id: 3 }));
  });
});
