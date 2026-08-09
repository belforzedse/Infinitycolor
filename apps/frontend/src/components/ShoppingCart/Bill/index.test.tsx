import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import ShoppingCartBillForm from ".";
import { currentUserAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { CartService } from "@/services";
import WalletService from "@/services/wallet";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));

jest.mock("@/lib/central-auth", () => ({
  centralAuth: {
    tokenManager: {
      getToken: jest.fn(),
    },
  },
  centralLoginUrl: jest.fn(() => "http://localhost:2889/auth"),
}));

const mockedCentralAuth = jest.requireMock("@/lib/central-auth") as {
  centralAuth: { tokenManager: { getToken: jest.Mock } };
};

let mockCartState = {
  totalPrice: 100_000,
  totalItems: 1,
  cartItems: [
    {
      id: "1",
      cartItemId: "10",
      variationId: "100",
      quantity: 1,
      price: 100_000,
    },
  ],
};

jest.mock("@/contexts/CartContext", () => ({
  useCart: () => ({
    ...mockCartState,
    clearCart: jest.fn(),
    openDrawer: jest.fn(),
    refreshCart: jest.fn(),
  }),
}));

jest.mock("@/services", () => ({
  CartService: {
    getAvailableGateways: jest.fn().mockResolvedValue(["samankish"]),
    getSnappEligible: jest.fn().mockResolvedValue({ eligible: false }),
    applyDiscount: jest.fn(),
    checkCartStock: jest.fn().mockResolvedValue({ valid: true }),
    getCheckoutQuote: jest.fn(),
    finalizeCart: jest.fn(),
  },
  OrderService: {
    getActiveReserve: jest.fn().mockResolvedValue({ data: null }),
  },
}));

jest.mock("@/services/wallet", () => ({
  __esModule: true,
  default: {
    getMyWallet: jest.fn().mockResolvedValue({ success: true, data: { balance: 0 } }),
  },
}));

jest.mock("@/lib/analytics", () => ({
  getAnalyticsCorrelationId: jest.fn(() => "guest-test-correlation"),
  trackFunnelStep: jest.fn(),
  trackAnalyticsEvent: jest.fn(),
}));

jest.mock("./InformationForm", () => ({
  __esModule: true,
  default: ({ setValue }: any) => (
    <div data-testid="checkout-information-form">
      <button
        type="button"
        data-testid="select-checkout-customer"
        onClick={() => {
          setValue("phoneNumber", "09123456789");
          setValue("address", { id: 5, label: "Test address" });
        }}
      >
        select customer
      </button>
    </div>
  ),
}));

jest.mock("./DeliveryForm", () => ({
  __esModule: true,
  default: ({ setValue }: any) => (
    <div data-testid="checkout-delivery-form">
      <button
        type="button"
        data-testid="select-shipping"
        onClick={() =>
          setValue("shippingMethod", {
            id: 7,
            code: "post",
            title: "Post",
            price: 20_000,
            basePrice: 20_000,
            sortOrder: 1,
          })
        }
      >
        select shipping
      </button>
    </div>
  ),
}));

jest.mock("./DiscountCoupon", () => ({
  __esModule: true,
  default: ({ onApplied }: any) => (
    <div data-testid="checkout-discount-coupon">
      <button
        type="button"
        data-testid="apply-discount"
        onClick={() =>
          onApplied?.("SUMMER", {
            discount: 10_000,
            summary: {
              subtotal: 100_000,
              eligibleSubtotal: 100_000,
              tax: 0,
              shipping: 0,
              total: 90_000,
              taxPercent: 0,
            },
          })
        }
      >
        apply discount
      </button>
    </div>
  ),
}));

jest.mock("./PaymentGateway", () => ({
  __esModule: true,
  default: ({ availableGateways, onChange, snappEligible }: any) => (
    <div data-testid="checkout-payment-gateway" data-snapp-eligible={String(snappEligible)}>
      <span data-testid="checkout-payment-gateway-count">{availableGateways?.length ?? 0}</span>
      {availableGateways?.includes("snappay") && (
        <button type="button" data-testid="select-snappay" onClick={() => onChange("snappay")}>
          select SnappPay
        </button>
      )}
    </div>
  ),
}));

jest.mock("./ReserveShipping", () => ({
  __esModule: true,
  default: () => <div data-testid="checkout-reserve-shipping" />,
}));

describe("ShoppingCartBillForm auth gate", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.pushState({}, "", "/checkout");
    mockCartState = {
      totalPrice: 100_000,
      totalItems: 1,
      cartItems: [
        {
          id: "1",
          cartItemId: "10",
          variationId: "100",
          quantity: 1,
          price: 100_000,
        },
      ],
    };
    jest.clearAllMocks();
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue(null);
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue(["samankish"]);
    (CartService.getSnappEligible as jest.Mock).mockResolvedValue({ eligible: false });
    (CartService.applyDiscount as jest.Mock).mockResolvedValue({
      success: true,
      discount: 10_000,
      summary: {
        subtotal: 100_000,
        eligibleSubtotal: 100_000,
        tax: 0,
        shipping: 0,
        total: 90_000,
        taxPercent: 0,
      },
    });
  });

  it("keeps the auth gate during initial token hydration and reveals the form once auth loading settles", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue("e2e-token");

    const store = createStore();
    store.set(currentUserAtom, null);
    store.set(userLoadingAtom, true);

    render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    expect(screen.getByTestId("checkout-auth-gate")).toBeInTheDocument();

    await act(async () => {
      store.set(userLoadingAtom, false);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("checkout-auth-gate")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("checkout-submit")).toBeVisible();
  });

  it("does not request protected checkout data before redirecting an anonymous shopper", async () => {
    const store = createStore();
    store.set(currentUserAtom, null);
    store.set(userLoadingAtom, false);

    render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("checkout-auth-gate")).toBeInTheDocument();
    });
    expect(CartService.getAvailableGateways).not.toHaveBeenCalled();
    expect(WalletService.getMyWallet).not.toHaveBeenCalled();
  });

  it("does not duplicate an already-applied discount preview from the coupon component", async () => {
    const store = createStore();
    store.set(currentUserAtom, { id: 1 });
    store.set(userLoadingAtom, false);

    render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("checkout-submit")).toBeVisible();
    });

    fireEvent.click(screen.getByTestId("apply-discount"));

    await act(async () => {
      await Promise.resolve();
    });
    expect(CartService.applyDiscount).not.toHaveBeenCalled();
  });

  it("revalidates an applied discount once when the cart signature changes", async () => {
    const store = createStore();
    store.set(currentUserAtom, { id: 1 });
    store.set(userLoadingAtom, false);

    const { rerender } = render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("checkout-submit")).toBeVisible();
    });

    fireEvent.click(screen.getByTestId("apply-discount"));

    await act(async () => {
      await Promise.resolve();
    });
    expect(CartService.applyDiscount).not.toHaveBeenCalled();

    mockCartState = {
      totalPrice: 150_000,
      totalItems: 1,
      cartItems: [
        {
          id: "1",
          cartItemId: "10",
          variationId: "100",
          quantity: 1,
          price: 150_000,
        },
      ],
    };

    rerender(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => {
      expect(CartService.applyDiscount).toHaveBeenCalledTimes(1);
    });
  });

  it("does not duplicate SnappPay eligibility for the same payable total and mode", async () => {
    const store = createStore();
    store.set(currentUserAtom, { id: 1 });
    store.set(userLoadingAtom, false);

    const { rerender } = render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("checkout-submit")).toBeVisible();
    });

    fireEvent.click(screen.getByTestId("select-shipping"));

    await waitFor(() => {
      expect(CartService.getSnappEligible).toHaveBeenCalledTimes(1);
    });

    rerender(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(CartService.getSnappEligible).toHaveBeenCalledTimes(1);
  });

  it("shows no gateway options and blocks submit when no backend gateways are active", async () => {
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue([]);

    const store = createStore();
    store.set(currentUserAtom, { id: 1 });
    store.set(userLoadingAtom, false);

    render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("checkout-payment-gateway-count")).toHaveTextContent("0");
    });

    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(CartService.finalizeCart).not.toHaveBeenCalled();
    });
    expect(CartService.checkCartStock).not.toHaveBeenCalled();
  });

  it("submits SnappPay only with a server quote and stable payment attempt", async () => {
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue(["snappay"]);
    (CartService.getSnappEligible as jest.Mock).mockResolvedValue({ eligible: true });
    (CartService.getCheckoutQuote as jest.Mock).mockResolvedValue({
      quoteHash: "sha256:snappay-quote",
      financialSummary: {
        subtotal: 100_000,
        discount: 0,
        tax: 0,
        shipping: 20_000,
        total: 120_000,
      },
    });
    (CartService.finalizeCart as jest.Mock).mockResolvedValue({
      success: false,
      message: "stop-after-request",
    });

    const store = createStore();
    store.set(currentUserAtom, { id: 1 });
    store.set(userLoadingAtom, false);

    render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("checkout-submit")).toBeVisible();
    });
    fireEvent.click(screen.getByTestId("select-checkout-customer"));
    fireEvent.click(screen.getByTestId("select-shipping"));

    await waitFor(() => {
      expect(screen.getByTestId("checkout-payment-gateway")).toHaveAttribute(
        "data-snapp-eligible",
        "true",
      );
    });
    fireEvent.click(screen.getByTestId("select-snappay"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
    });
    expect(CartService.getCheckoutQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        shipping: 7,
        addressId: 5,
        gateway: "snappay",
        mobile: "09123456789",
      }),
    );
    expect(CartService.finalizeCart).toHaveBeenCalledWith(
      expect.objectContaining({
        shipping: 7,
        addressId: 5,
        gateway: "snappay",
        mobile: "09123456789",
        quoteHash: "sha256:snappay-quote",
        attemptId: expect.any(String),
        analyticsCorrelationId: "guest-test-correlation",
      }),
    );
    const submitted = (CartService.finalizeCart as jest.Mock).mock.calls[0][0];
    expect(submitted.attemptId).toBeTruthy();
    expect(localStorage.getItem("pendingCheckoutAttemptId")).toBe(submitted.attemptId);
    expect(localStorage.getItem("pendingCheckoutQuoteHash")).toBe("sha256:snappay-quote");
  });
});
