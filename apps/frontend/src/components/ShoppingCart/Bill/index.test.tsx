import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import ShoppingCartBillForm from ".";
import { currentUserAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { CartService } from "@/services";
import WalletService from "@/services/wallet";

const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn() }),
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
}));

jest.mock("@sentry/nextjs", () => ({
  captureMessage: jest.fn(),
}));

const mockToast = (jest.requireMock("react-hot-toast") as {
  default: { error: jest.Mock; success: jest.Mock };
}).default;
const captureCheckoutMessage = (
  jest.requireMock("@sentry/nextjs") as { captureMessage: jest.Mock }
).captureMessage;

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

let mockStockNotice: {
  adjustedCartItemIds: string[];
  removedNames: string[];
} | null = null;

const mockRefreshCart = jest.fn().mockResolvedValue(undefined);
const mockSetStockNotice = jest.fn(
  (notice: { adjustedCartItemIds: string[]; removedNames: string[] } | null) => {
    mockStockNotice = notice;
  },
);

jest.mock("@/contexts/CartContext", () => ({
  useCart: () => ({
    ...mockCartState,
    clearCart: jest.fn(),
    openDrawer: jest.fn(),
    refreshCart: mockRefreshCart,
    setStockNotice: mockSetStockNotice,
    stockNotice: mockStockNotice,
    dismissStockNotice: jest.fn(() => {
      mockStockNotice = null;
    }),
  }),
}));

jest.mock("@/services", () => ({
  CartService: {
    getAvailableGateways: jest.fn().mockResolvedValue(["samankish"]),
    // Capabilities travel with the gateway list so the UI never infers a server
    // feature flag from an absent field.
    getCheckoutPaymentOptions: jest.fn().mockResolvedValue({
      gateways: ["samankish"],
      paymentCapabilities: {
        walletEnabled: false,
        splitEnabled: false,
        splitDisabledReason: "disabled",
        splitGateways: [],
        gatewayMinimumsToman: {},
      },
    }),
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
      <button
        type="button"
        data-testid="select-shipping-express"
        onClick={() =>
          setValue("shippingMethod", {
            id: 8,
            code: "express",
            title: "Express",
            price: 40_000,
            basePrice: 40_000,
            sortOrder: 2,
          })
        }
      >
        select express
      </button>
    </div>
  ),
}));

jest.mock("./DiscountCoupon", () => ({
  __esModule: true,
  default: ({
    onApplied,
    onRemove,
  }: {
    onApplied?: (
      code: string,
      preview: {
        discount: number;
        summary: {
          subtotal: number;
          eligibleSubtotal: number;
          tax: number;
          shipping: number;
          total: number;
          taxPercent: number;
        };
      },
    ) => void;
    onRemove?: () => void;
  }) => (
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
              shipping: 20_000,
              total: 110_000,
              taxPercent: 0,
            },
          })
        }
      >
        apply discount
      </button>
      <button type="button" data-testid="remove-discount" onClick={() => onRemove?.()}>
        remove discount
      </button>
    </div>
  ),
}));

jest.mock("./PaymentGateway", () => ({
  __esModule: true,
  default: ({ availableGateways, onChange, snappEligible, walletBalanceIrr }: any) => (
    <div
      data-testid="checkout-payment-gateway"
      data-snapp-eligible={String(snappEligible)}
      data-wallet-balance-irr={String(walletBalanceIrr ?? 0)}
    >
      <span data-testid="checkout-payment-gateway-count">{availableGateways?.length ?? 0}</span>
      {availableGateways?.includes("snappay") && (
        <button type="button" data-testid="select-snappay" onClick={() => onChange("snappay")}>
          select SnappPay
        </button>
      )}
      {availableGateways?.includes("mellat") && (
        <button type="button" data-testid="select-mellat" onClick={() => onChange("mellat")}>
          select Mellat
        </button>
      )}
      {availableGateways?.includes("wallet") && (
        <button type="button" data-testid="select-wallet" onClick={() => onChange("wallet")}>
          select wallet
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
    mockStockNotice = null;
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
    mockRefreshCart.mockResolvedValue(undefined);
    mockPush.mockReset();
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue(null);
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue(["samankish"]);
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: ["samankish"],
      paymentCapabilities: {
        walletEnabled: ["samankish"].includes("wallet"),
        splitEnabled: false,
        splitDisabledReason: "disabled",
        splitGateways: [],
        gatewayMinimumsToman: {},
      },
    });
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: ["samankish"],
      paymentCapabilities: {
        walletEnabled: false,
        splitEnabled: false,
        splitDisabledReason: "disabled",
        splitGateways: [],
        gatewayMinimumsToman: {},
      },
    });
    (CartService.getSnappEligible as jest.Mock).mockResolvedValue({ eligible: false });
    (CartService.checkCartStock as jest.Mock).mockResolvedValue({ valid: true });
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
    expect(CartService.getSnappEligible).not.toHaveBeenCalled();
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

  it("checks SnappPay on checkout entry and refreshes when payable inputs change", async () => {
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

    await waitFor(() => {
      expect(CartService.getSnappEligible).toHaveBeenCalledTimes(1);
    });
    expect(CartService.getSnappEligible).toHaveBeenLastCalledWith({ amount: 100_000 });

    fireEvent.click(screen.getByTestId("select-shipping"));

    await waitFor(() => {
      expect(CartService.getSnappEligible).toHaveBeenCalledTimes(2);
    });
    expect(CartService.getSnappEligible).toHaveBeenLastCalledWith({ amount: 120_000 });

    fireEvent.click(screen.getByTestId("apply-discount"));

    await waitFor(() => {
      expect(CartService.getSnappEligible).toHaveBeenCalledTimes(3);
    });
    expect(CartService.getSnappEligible).toHaveBeenLastCalledWith({ amount: 110_000 });

    rerender(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(CartService.getSnappEligible).toHaveBeenCalledTimes(3);
  });

  it("shows no gateway options and blocks submit when no backend gateways are active", async () => {
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue([]);
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: [],
      paymentCapabilities: {
        walletEnabled: [].includes("wallet"),
        splitEnabled: false,
        splitDisabledReason: "disabled",
        splitGateways: [],
        gatewayMinimumsToman: {},
      },
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
      expect(screen.getByTestId("checkout-payment-gateway-count")).toHaveTextContent("0");
    });

    (CartService.checkCartStock as jest.Mock).mockClear();
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(CartService.finalizeCart).not.toHaveBeenCalled();
    });
    // Submit is blocked before the stock guard (no selectable gateway).
    expect(CartService.checkCartStock).not.toHaveBeenCalled();
  });

  it("submits SnappPay only with a server quote and stable payment attempt", async () => {
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue(["snappay"]);
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: ["snappay"],
      paymentCapabilities: {
        walletEnabled: ["snappay"].includes("wallet"),
        splitEnabled: false,
        splitDisabledReason: "disabled",
        splitGateways: [],
        gatewayMinimumsToman: {},
      },
    });
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
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
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

  it("follows a SnappPay finalize redirectUrl (resume response shape) instead of the result page", async () => {
    const paymentPageUrl = "https://pay.snapp.test/start?paymentToken=resume-token";

    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue(["snappay"]);
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: ["snappay"],
      paymentCapabilities: {
        walletEnabled: ["snappay"].includes("wallet"),
        splitEnabled: false,
        splitDisabledReason: "disabled",
        splitGateways: [],
        gatewayMinimumsToman: {},
      },
    });
    (CartService.getSnappEligible as jest.Mock).mockResolvedValue({ eligible: true });
    (CartService.getCheckoutQuote as jest.Mock).mockResolvedValue({
      quoteHash: "sha256:snappay-resume-quote",
      financialSummary: {
        subtotal: 100_000,
        discount: 0,
        tax: 0,
        shipping: 20_000,
        total: 120_000,
      },
    });
    (CartService.finalizeCart as jest.Mock).mockResolvedValue({
      success: true,
      orderId: 91,
      attemptId: "attempt-resume",
      redirectUrl: paymentPageUrl,
      paymentStatus: "Redirected",
    });

    const store = createStore();
    store.set(currentUserAtom, { id: 1 });
    store.set(userLoadingAtom, false);

    render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => expect(screen.getByTestId("checkout-submit")).toBeVisible());
    fireEvent.click(screen.getByTestId("select-checkout-customer"));
    fireEvent.click(screen.getByTestId("select-shipping"));
    await waitFor(() => {
      expect(screen.getByTestId("checkout-payment-gateway")).toHaveAttribute(
        "data-snapp-eligible",
        "true",
      );
    });
    fireEvent.click(screen.getByTestId("select-snappay"));
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    // jsdom cannot assign window.location.href (non-configurable); the storefront
    // still takes the gateway-redirect branch — toast + pending ids, not /payment/result.
    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith("در حال انتقال به درگاه پرداخت...");
    });
    expect(CartService.finalizeCart).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: "snappay",
        quoteHash: "sha256:snappay-resume-quote",
        attemptId: expect.any(String),
      }),
    );
    expect(mockPush).not.toHaveBeenCalled();
    expect(localStorage.getItem("pendingOrderId")).toBe("91");
    expect(localStorage.getItem("pendingPaymentAttemptId")).toBe("attempt-resume");
    expect(localStorage.getItem("pendingCheckoutAttemptId")).toBeTruthy();
  });

  it("on bfcache restore only unsticks پرداخت and does not auto-redirect to SnappPay", async () => {
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue(["snappay"]);
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: ["snappay"],
      paymentCapabilities: {
        walletEnabled: ["snappay"].includes("wallet"),
        splitEnabled: false,
        splitDisabledReason: "disabled",
        splitGateways: [],
        gatewayMinimumsToman: {},
      },
    });
    (CartService.getSnappEligible as jest.Mock).mockResolvedValue({ eligible: true });

    const store = createStore();
    store.set(currentUserAtom, { id: 1 });
    store.set(userLoadingAtom, false);

    render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => expect(screen.getByTestId("checkout-submit")).toBeVisible());
    (CartService.finalizeCart as jest.Mock).mockClear();
    (CartService.checkCartStock as jest.Mock).mockClear();

    await act(async () => {
      window.dispatchEvent(new Event("pageshow"));
      // Persisted bfcache restore is what unsticks the submit guard.
      const persisted = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(persisted, "persisted", { value: true });
      window.dispatchEvent(persisted);
    });

    expect(CartService.finalizeCart).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    // Stock recheck on restore is intentional; auto-redirect is not.
    await waitFor(() => {
      expect(CartService.checkCartStock).toHaveBeenCalled();
    });
  });

  it("routes an immediately paid wallet order to the canonical result page", async () => {
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue(["wallet"]);
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: ["wallet"],
      paymentCapabilities: {
        walletEnabled: ["wallet"].includes("wallet"),
        splitEnabled: false,
        splitDisabledReason: "disabled",
        splitGateways: [],
        gatewayMinimumsToman: {},
      },
    });
    (CartService.getCheckoutQuote as jest.Mock).mockResolvedValue({
      quoteHash: "sha256:wallet-quote",
      financialSummary: {
        subtotal: 100_000,
        discount: 0,
        tax: 0,
        shipping: 20_000,
        total: 120_000,
      },
    });
    (CartService.finalizeCart as jest.Mock).mockResolvedValue({
      success: true,
      orderId: 88,
      redirectUrl: "",
      paymentStatus: "Succeeded",
    });

    const store = createStore();
    store.set(currentUserAtom, { id: 1 });
    store.set(userLoadingAtom, false);

    render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => expect(screen.getByTestId("select-wallet")).toBeVisible());
    fireEvent.click(screen.getByTestId("select-checkout-customer"));
    fireEvent.click(screen.getByTestId("select-shipping"));
    fireEvent.click(screen.getByTestId("select-wallet"));
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/payment/result?orderId=88");
    });
  });

  it("offers the wallet-only card no credit while another checkout holds the balance", async () => {
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue(["wallet", "mellat"]);
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: ["wallet", "mellat"],
      paymentCapabilities: {
        walletEnabled: true,
        splitEnabled: true,
        splitDisabledReason: null,
        splitGateways: ["mellat"],
        gatewayMinimumsToman: { mellat: 1000 },
      },
    });
    // The posted balance would cover the order, but every rial of it is
    // committed to a checkout this shopper already started.
    (WalletService.getMyWallet as jest.Mock).mockResolvedValue({
      success: true,
      data: { balance: 5_000_000, heldBalance: 5_000_000, availableBalance: 0 },
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
      expect(screen.getByTestId("checkout-payment-gateway")).toHaveAttribute(
        "data-wallet-balance-irr",
        "0",
      );
    });
  });

  it("blocks payment until the shopper accepts the site terms", async () => {
    (CartService.getCheckoutQuote as jest.Mock).mockResolvedValue({
      quoteHash: "sha256:terms-quote",
      financialSummary: { total: 120_000 },
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
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(
        screen.getByText("برای ثبت سفارش باید قوانین و مقررات سایت را بپذیرید"),
      ).toBeInTheDocument();
    });
    // The inline box sits above the fold on a phone, so the rejection must also
    // surface as a toast next to the button the shopper actually tapped.
    expect(mockToast.error).toHaveBeenCalledWith(
      "برای ثبت سفارش باید قوانین و مقررات سایت را بپذیرید",
      { id: "checkout-error" },
    );
    expect(CartService.getCheckoutQuote).not.toHaveBeenCalled();
    expect(CartService.finalizeCart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
    });
  });

  it("toasts a backend checkout failure instead of only rendering it inline", async () => {
    (CartService.getCheckoutQuote as jest.Mock).mockResolvedValue({
      // Must equal the shopper-visible total, or the quote-review guard fires
      // first and we would be asserting on the wrong error path.
      quoteHash: "sha256:failing-quote",
      financialSummary: { total: 120_000 },
    });
    (CartService.finalizeCart as jest.Mock).mockResolvedValue({
      success: false,
      errorCode: "CART_EMPTY",
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
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("سبد خرید شما خالی است", {
        id: "checkout-error",
      });
    });
    // Inline surface is kept as well -- the toast is additive, not a replacement.
    expect(screen.getByTestId("checkout-form-error")).toHaveTextContent(
      "سبد خرید شما خالی است",
    );
    expect(captureCheckoutMessage).not.toHaveBeenCalled();
  });

  async function submitCheckoutWithError(
    errorCode: string,
    extras: Record<string, unknown> = {},
  ) {
    (CartService.getCheckoutQuote as jest.Mock).mockResolvedValue({
      quoteHash: "sha256:failing-quote",
      financialSummary: { total: 120_000 },
    });
    (CartService.finalizeCart as jest.Mock).mockResolvedValue({
      success: false,
      errorCode,
      ...extras,
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
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));
  }

  it("does not send expected in-progress checkout codes to Sentry as errors", async () => {
    await submitCheckoutWithError("PAYMENT_IN_PROGRESS");

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(
        "پرداخت قبلی هنوز در حال بررسی است. لطفاً چند لحظه بعد وضعیت سفارش را بررسی کنید.",
        { id: "checkout-error" },
      );
    });
    expect(captureCheckoutMessage).not.toHaveBeenCalled();
  });

  it("does not send SnapPay manual-review leftovers to Sentry as errors", async () => {
    await submitCheckoutWithError("SNAPPAY_MANUAL_REVIEW");

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(
        "پرداخت اسنپ‌پی در حال بررسی دستی است. لطفاً وضعیت سفارش را کمی بعد بررسی کنید و دوباره پرداخت نکنید.",
        { id: "checkout-error" },
      );
    });
    expect(captureCheckoutMessage).not.toHaveBeenCalled();
  });

  it("shows cancelled-order copy that does not tell the shopper to pay again", async () => {
    await submitCheckoutWithError("ORDER_CANCELLED");

    await waitFor(() => {
      expect(screen.getByTestId("checkout-form-error")).toHaveTextContent(
        "این سفارش لغو شده است. از پرداخت دوباره خودداری کنید و وضعیت سفارش را در حساب کاربری بررسی کنید.",
      );
    });
    expect(captureCheckoutMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId("checkout-form-error").textContent).not.toMatch(/دوباره تلاش/);
  });

  it("still reports unexpected checkout failures to Sentry", async () => {
    await submitCheckoutWithError("WALLET_DEBIT_FAILED");

    await waitFor(() => {
      expect(captureCheckoutMessage).toHaveBeenCalledWith(
        "checkout.error:WALLET_DEBIT_FAILED",
        expect.objectContaining({ level: "error" }),
      );
    });
  });

  it("does not send CART_EMPTY or REVERT leftovers to Sentry as errors", async () => {
    await submitCheckoutWithError("REVERT");

    await waitFor(() => {
      expect(screen.getByTestId("checkout-form-error")).toBeVisible();
    });
    expect(captureCheckoutMessage).not.toHaveBeenCalled();
  });

  it("reports unmapped backend copy at warning instead of error", async () => {
    (CartService.getCheckoutQuote as jest.Mock).mockResolvedValue({
      quoteHash: "sha256:failing-quote",
      financialSummary: { total: 120_000 },
    });
    (CartService.finalizeCart as jest.Mock).mockResolvedValue({
      success: false,
      message: "Cannot create order from empty cart",
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
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(captureCheckoutMessage).toHaveBeenCalledWith(
        "checkout.error:BACKEND_MESSAGE",
        expect.objectContaining({ level: "warning" }),
      );
    });
  });

  it("maps an invalid SnappPay mobile to Persian copy and clears the stored attempt", async () => {
    window.localStorage.setItem("pendingCheckoutAttemptId", "stale-attempt");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:failing-quote");
    await submitCheckoutWithError("SNAPPAY_INVALID_MOBILE");

    await waitFor(() => {
      expect(screen.getByTestId("checkout-form-error")).toHaveTextContent(
        "شماره موبایل ثبت‌شده برای پرداخت اقساطی معتبر نیست",
      );
    });
    expect(window.localStorage.getItem("pendingCheckoutAttemptId")).toBeNull();
  });

  it("keeps the stored attempt id when SnappPay status is still unreadable", async () => {
    window.localStorage.setItem("pendingCheckoutAttemptId", "live-attempt");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:failing-quote");
    await submitCheckoutWithError("PAYMENT_UNKNOWN");

    await waitFor(() => {
      expect(screen.getByTestId("checkout-form-error")).toHaveTextContent(
        "نتیجه شروع پرداخت هنوز مشخص نیست",
      );
    });
    expect(window.localStorage.getItem("pendingCheckoutAttemptId")).toBe("live-attempt");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("opens the payment result page when unknown SnapPay start includes an order id", async () => {
    window.localStorage.setItem("pendingCheckoutAttemptId", "live-attempt");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:failing-quote");
    await submitCheckoutWithError("PAYMENT_UNKNOWN", { orderId: 91 });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/payment/result?orderId=91");
    });
    expect(mockToast.success).toHaveBeenCalledWith("در حال بررسی نتیجه پرداخت...", {
      id: "checkout-error",
    });
    expect(screen.queryByTestId("checkout-form-error")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("pendingOrderId")).toBe("91");
    expect(window.localStorage.getItem("pendingCheckoutAttemptId")).toBe("live-attempt");
    expect(window.localStorage.getItem("pendingPaymentAttemptId")).toBeTruthy();
  });

  it("retries checkout from تلاش دوباره instead of only dismissing the banner", async () => {
    window.localStorage.setItem("pendingCheckoutAttemptId", "live-attempt");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:failing-quote");
    await submitCheckoutWithError("PAYMENT_UNKNOWN");

    await waitFor(() => {
      expect(screen.getByTestId("checkout-error-retry")).toBeVisible();
    });
    expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("checkout-error-retry"));

    await waitFor(() => {
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(2);
    });
  });

  it("opens the payment result page when an in-progress SnapPay 409 names the order", async () => {
    (CartService.getCheckoutQuote as jest.Mock).mockResolvedValue({
      quoteHash: "sha256:failing-quote",
      financialSummary: { total: 120_000 },
    });
    (CartService.finalizeCart as jest.Mock).mockRejectedValue({
      status: 409,
      errorCode: "PAYMENT_IN_PROGRESS",
      data: { errorCode: "PAYMENT_IN_PROGRESS", orderId: 111459 },
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
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/payment/result?orderId=111459");
    });
    expect(screen.queryByTestId("checkout-form-error")).not.toBeInTheDocument();
  });

  it("keeps the stored attempt id when a SnappPay token request fails after dispatch", async () => {
    window.localStorage.setItem("pendingCheckoutAttemptId", "live-attempt");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:failing-quote");
    await submitCheckoutWithError("SNAPPAY_TOKEN_500");

    await waitFor(() => {
      expect(screen.getByTestId("checkout-form-error")).toHaveTextContent(
        "شروع پرداخت اسنپ‌پی انجام نشد",
      );
    });
    expect(window.localStorage.getItem("pendingCheckoutAttemptId")).toBe("live-attempt");
  });

  it("keeps the stored attempt id when SnappPay is parked for review", async () => {
    window.localStorage.setItem("pendingCheckoutAttemptId", "live-attempt");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:failing-quote");
    await submitCheckoutWithError("SNAPPAY_MANUAL_REVIEW");

    await waitFor(() => {
      expect(screen.getByTestId("checkout-form-error")).toHaveTextContent(
        "پرداخت اسنپ‌پی در حال بررسی دستی است",
      );
    });
    expect(window.localStorage.getItem("pendingCheckoutAttemptId")).toBe("live-attempt");
  });

  it("clears a conflicting checkout attempt so the next tap can start a new one", async () => {
    window.localStorage.setItem("pendingCheckoutAttemptId", "dead-attempt");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:failing-quote");
    await submitCheckoutWithError("CHECKOUT_ATTEMPT_CONFLICT");

    await waitFor(() => {
      expect(window.localStorage.getItem("pendingCheckoutAttemptId")).toBeNull();
    });
  });

  it("announces a reserved/OOS stock correction instead of silently idle پرداخت", async () => {
    const noticeText =
      "موجودی برخی اقلام تغییر کرد و سبد خرید شما به‌روز شد. رنگ قرمز ناموجود شد و از سبد حذف شد.";
    (CartService.checkCartStock as jest.Mock).mockResolvedValue({
      valid: false,
      cartIsEmpty: false,
      itemsRemoved: [
        {
          cartItemId: 10,
          productVariationId: 100,
          productTitle: "رنگ قرمز",
          message: "Product is out of stock, item removed from cart",
        },
      ],
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

    // Mount already reconciled; clear so we only assert the submit path.
    (CartService.checkCartStock as jest.Mock).mockClear();
    (CartService.getCheckoutQuote as jest.Mock).mockClear();
    (CartService.finalizeCart as jest.Mock).mockClear();
    mockToast.error.mockClear();
    mockSetStockNotice.mockClear();

    fireEvent.click(screen.getByTestId("select-checkout-customer"));
    fireEvent.click(screen.getByTestId("select-shipping"));
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(noticeText, { id: "checkout-error" });
    });
    expect(screen.getByTestId("checkout-form-error")).toHaveTextContent("رنگ قرمز");
    expect(screen.getByTestId("cart-stock-notice")).toHaveTextContent("رنگ قرمز");
    expect(mockSetStockNotice).toHaveBeenCalledWith({
      adjustedCartItemIds: [],
      removedNames: ["رنگ قرمز"],
    });
    expect(mockRefreshCart).toHaveBeenCalled();
    expect(CartService.getCheckoutQuote).not.toHaveBeenCalled();
    expect(CartService.finalizeCart).not.toHaveBeenCalled();
  });

  it("shows empty-cart copy when stock correction removes every line", async () => {
    (CartService.checkCartStock as jest.Mock).mockResolvedValue({
      valid: false,
      cartIsEmpty: true,
      itemsRemoved: [
        {
          cartItemId: 10,
          productVariationId: 100,
          productTitle: "رنگ قرمز",
          message: "Product is out of stock, item removed from cart",
        },
      ],
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

    (CartService.checkCartStock as jest.Mock).mockClear();
    (CartService.getCheckoutQuote as jest.Mock).mockClear();
    mockToast.error.mockClear();

    fireEvent.click(screen.getByTestId("select-checkout-customer"));
    fireEvent.click(screen.getByTestId("select-shipping"));
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("سبد خرید شما خالی است", {
        id: "checkout-error",
      });
    });
    expect(CartService.getCheckoutQuote).not.toHaveBeenCalled();
    expect(CartService.finalizeCart).not.toHaveBeenCalled();
  });

  it("does not re-check stock when the cart snapshot identity changes after a correction", async () => {
    (CartService.checkCartStock as jest.Mock).mockResolvedValue({
      valid: false,
      cartIsEmpty: false,
      itemsRemoved: [
        {
          cartItemId: 10,
          productVariationId: 100,
          productTitle: "رنگ قرمز",
          message: "Product is out of stock, item removed from cart",
        },
      ],
    });

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
    await waitFor(() => {
      expect(CartService.checkCartStock).toHaveBeenCalled();
    });

    const callsAfterMount = (CartService.checkCartStock as jest.Mock).mock.calls.length;
    expect(mockRefreshCart).toHaveBeenCalledWith({ silent: true });

    mockCartState = {
      ...mockCartState,
      cartItems: mockCartState.cartItems.map((item) => ({ ...item })),
    };

    rerender(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(CartService.checkCartStock).toHaveBeenCalledTimes(callsAfterMount);
  });

  it("passes the stored attempt id into checkout stock checks", async () => {
    window.localStorage.setItem("pendingCheckoutAttemptId", "attempt-111459");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:original");

    const store = createStore();
    store.set(currentUserAtom, { id: 1 });
    store.set(userLoadingAtom, false);

    render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => {
      expect(CartService.checkCartStock).toHaveBeenCalledWith("attempt-111459");
    });
  });

  it("continues an identified unpaid order when the mutable cart is empty", async () => {
    mockCartState = {
      totalPrice: 0,
      totalItems: 0,
      cartItems: [],
    };
    window.localStorage.setItem("pendingCheckoutAttemptId", "attempt-111459");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:original");
    window.localStorage.setItem("pendingCheckoutOrderId", "111459");
    window.localStorage.setItem("pendingCheckoutGateway", "snappay");
    (CartService.checkCartStock as jest.Mock).mockResolvedValue({
      valid: true,
      reservationOutcome: "held",
      heldOrderId: 111459,
      resumableCheckout: {
        attemptId: "attempt-111459",
        orderId: 111459,
        quoteHash: "sha256:original",
        gateway: "snappay",
      },
    });
    (CartService.finalizeCart as jest.Mock).mockResolvedValue({
      success: true,
      orderId: 111459,
      attemptId: "attempt-111459",
      redirectUrl: "https://pay.snapp.test/start",
      paymentStatus: "Redirected",
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
      expect(CartService.checkCartStock).toHaveBeenCalled();
      expect(screen.queryByTestId("checkout-form-error")).not.toBeInTheDocument();
      expect(screen.getByTestId("checkout-submit")).toBeVisible();
    });
    expect(screen.queryByText(/هنوز در انتظار پرداخت است/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(CartService.finalizeCart).toHaveBeenCalledWith(
        expect.objectContaining({
          gateway: "snappay",
          attemptId: "attempt-111459",
          quoteHash: "sha256:original",
        }),
      );
    });
    expect(CartService.getCheckoutQuote).not.toHaveBeenCalled();
  });

  it("hydrates checkout identity from resumableCheckout when localStorage is empty", async () => {
    mockCartState = {
      totalPrice: 0,
      totalItems: 0,
      cartItems: [],
    };
    (CartService.checkCartStock as jest.Mock).mockResolvedValue({
      valid: true,
      reservationOutcome: "held",
      heldOrderId: 111459,
      resumableCheckout: {
        attemptId: "attempt-111459",
        orderId: 111459,
        quoteHash: "sha256:original",
        gateway: "snappay",
      },
    });
    (CartService.finalizeCart as jest.Mock).mockResolvedValue({
      success: true,
      orderId: 111459,
      attemptId: "attempt-111459",
      redirectUrl: "https://pay.snapp.test/start",
      paymentStatus: "Redirected",
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
      expect(window.localStorage.getItem("pendingCheckoutAttemptId")).toBe("attempt-111459");
      expect(window.localStorage.getItem("pendingCheckoutQuoteHash")).toBe("sha256:original");
      expect(screen.queryByTestId("checkout-form-error")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(CartService.finalizeCart).toHaveBeenCalledWith(
        expect.objectContaining({
          gateway: "snappay",
          attemptId: "attempt-111459",
          quoteHash: "sha256:original",
        }),
      );
    });
    expect(CartService.getCheckoutQuote).not.toHaveBeenCalled();
  });

  it("does not continue an empty cart after the reservation has expired", async () => {
    mockCartState = {
      totalPrice: 0,
      totalItems: 0,
      cartItems: [],
    };
    window.localStorage.setItem("pendingCheckoutAttemptId", "attempt-111459");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:original");
    window.localStorage.setItem("pendingCheckoutOrderId", "111459");
    window.localStorage.setItem("pendingCheckoutGateway", "snappay");
    (CartService.checkCartStock as jest.Mock).mockResolvedValue({
      valid: true,
      reservationOutcome: "expired",
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
      expect(screen.queryByText(/مهلت رزرو موجودی این سفارش تمام شده است/)).not.toBeInTheDocument();
      expect(screen.getByTestId("checkout-form-error")).toHaveTextContent(
        "سبد خرید شما خالی است",
      );
    });
    expect(window.localStorage.getItem("pendingCheckoutAttemptId")).toBeNull();
    expect(CartService.finalizeCart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });
    expect(CartService.finalizeCart).not.toHaveBeenCalled();
    expect(CartService.getCheckoutQuote).not.toHaveBeenCalled();
  });

  it("submits a new card attempt without crediting the stored SnappPay hold", async () => {
    window.localStorage.setItem("pendingCheckoutAttemptId", "attempt-111459");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:original");
    window.localStorage.setItem("pendingCheckoutOrderId", "111459");
    window.localStorage.setItem("pendingCheckoutGateway", "snappay");
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue(["snappay", "mellat"]);
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: ["snappay", "mellat"],
      paymentCapabilities: {
        walletEnabled: ["snappay", "mellat"].includes("wallet"),
        splitEnabled: false,
        splitDisabledReason: "disabled",
        splitGateways: [],
        gatewayMinimumsToman: {},
      },
    });
    (CartService.getSnappEligible as jest.Mock).mockResolvedValue({ eligible: true });
    (CartService.getCheckoutQuote as jest.Mock).mockResolvedValue({
      quoteHash: "sha256:card-quote",
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
      expect(screen.getByTestId("select-mellat")).toBeVisible();
    });
    fireEvent.click(screen.getByTestId("select-checkout-customer"));
    fireEvent.click(screen.getByTestId("select-shipping"));
    fireEvent.click(screen.getByTestId("select-mellat"));
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
    });
    expect(CartService.checkCartStock).toHaveBeenLastCalledWith(undefined);
    expect(CartService.finalizeCart).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: "mellat",
        quoteHash: "sha256:card-quote",
        attemptId: expect.any(String),
      }),
    );
    const submitted = (CartService.finalizeCart as jest.Mock).mock.calls[0][0];
    expect(submitted.attemptId).not.toBe("attempt-111459");
    expect(window.localStorage.getItem("continuableCheckoutAttemptId")).toBe("attempt-111459");
  });

  it("does not replay SnappPay when the cart is empty and a card gateway is selected", async () => {
    mockCartState = {
      totalPrice: 0,
      totalItems: 0,
      cartItems: [],
    };
    window.localStorage.setItem("pendingCheckoutAttemptId", "attempt-111459");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:original");
    window.localStorage.setItem("pendingCheckoutOrderId", "111459");
    window.localStorage.setItem("pendingCheckoutGateway", "snappay");
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue(["snappay", "mellat"]);
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: ["snappay", "mellat"],
      paymentCapabilities: {
        walletEnabled: ["snappay", "mellat"].includes("wallet"),
        splitEnabled: false,
        splitDisabledReason: "disabled",
        splitGateways: [],
        gatewayMinimumsToman: {},
      },
    });
    (CartService.getSnappEligible as jest.Mock).mockResolvedValue({ eligible: true });

    const store = createStore();
    store.set(currentUserAtom, { id: 1 });
    store.set(userLoadingAtom, false);

    render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("select-mellat")).toBeVisible();
    });
    fireEvent.click(screen.getByTestId("select-mellat"));
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });
    expect(CartService.finalizeCart).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("pendingCheckoutAttemptId")).toBe("attempt-111459");
    expect(window.localStorage.getItem("pendingCheckoutGateway")).toBe("snappay");
  });

  it("does not offer a resume path for a leftover unpaid order on a new basket", async () => {
    window.localStorage.setItem("continuableCheckoutAttemptId", "attempt-111459");
    window.localStorage.setItem("continuableCheckoutQuoteHash", "sha256:coat");
    window.localStorage.setItem("continuableCheckoutOrderId", "111459");
    window.localStorage.setItem("continuableCheckoutGateway", "snappay");

    const store = createStore();
    store.set(currentUserAtom, { id: 1 });
    store.set(userLoadingAtom, false);

    render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => {
      expect(screen.getByText("اطلاعات صورت حساب")).toBeVisible();
    });
    expect(screen.queryByTestId("checkout-distinct-continuation")).not.toBeInTheDocument();
    expect(screen.queryByTestId("checkout-continue-previous")).not.toBeInTheDocument();
    expect(CartService.finalizeCart).not.toHaveBeenCalled();
  });

  it("maps an expired reservation without sending it to Sentry", async () => {
    await submitCheckoutWithError("RESERVATION_EXPIRED");

    await waitFor(() => {
      expect(screen.getByTestId("checkout-form-error")).toHaveTextContent(
        "مهلت رزرو موجودی این سفارش تمام شده است",
      );
    });
    expect(captureCheckoutMessage).not.toHaveBeenCalled();
  });

  it("keeps the stored attempt when reservation lookup fails instead of treating stock as gone", async () => {
    window.localStorage.setItem("pendingCheckoutAttemptId", "live-attempt");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:failing-quote");
    await submitCheckoutWithError("RESERVATION_LOOKUP_FAILED");

    await waitFor(() => {
      expect(screen.getByTestId("checkout-form-error")).toHaveTextContent(
        "وضعیت رزرو موجودی این سفارش الان مشخص نیست",
      );
    });
    expect(screen.getByTestId("checkout-form-error")).toHaveTextContent("دوباره تلاش کنید");
    expect(window.localStorage.getItem("pendingCheckoutAttemptId")).toBe("live-attempt");
    expect(captureCheckoutMessage).not.toHaveBeenCalled();
  });

  it("does not strip cart lines or finalize when check-stock cannot read the reservation", async () => {
    window.localStorage.setItem("pendingCheckoutAttemptId", "live-attempt");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:original");
    (CartService.checkCartStock as jest.Mock).mockResolvedValue({
      success: false,
      valid: false,
      errorCode: "RESERVATION_LOOKUP_FAILED",
      reservationOutcome: "unavailable",
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

    (CartService.checkCartStock as jest.Mock).mockClear();
    (CartService.getCheckoutQuote as jest.Mock).mockClear();
    (CartService.finalizeCart as jest.Mock).mockClear();
    mockToast.error.mockClear();
    mockSetStockNotice.mockClear();

    fireEvent.click(screen.getByTestId("select-checkout-customer"));
    fireEvent.click(screen.getByTestId("select-shipping"));
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("checkout-form-error")).toHaveTextContent(
        "وضعیت رزرو موجودی این سفارش الان مشخص نیست",
      );
    });
    expect(mockSetStockNotice).not.toHaveBeenCalled();
    expect(CartService.getCheckoutQuote).not.toHaveBeenCalled();
    expect(CartService.finalizeCart).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("pendingCheckoutAttemptId")).toBe("live-attempt");
  });

  it("mints a new attempt when only the coupon is applied, then again when it is removed", async () => {
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue(["mellat"]);
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: ["mellat"],
      paymentCapabilities: {
        walletEnabled: ["mellat"].includes("wallet"),
        splitEnabled: false,
        splitDisabledReason: "disabled",
        splitGateways: [],
        gatewayMinimumsToman: {},
      },
    });
    (CartService.applyDiscount as jest.Mock).mockResolvedValue({
      success: true,
      discount: 10_000,
      summary: {
        subtotal: 100_000,
        eligibleSubtotal: 100_000,
        tax: 0,
        shipping: 20_000,
        total: 110_000,
        taxPercent: 0,
      },
    });
    (CartService.getCheckoutQuote as jest.Mock)
      .mockResolvedValueOnce({
        quoteHash: "sha256:undiscounted",
        financialSummary: {
          subtotal: 100_000,
          discount: 0,
          tax: 0,
          shipping: 20_000,
          total: 120_000,
        },
      })
      .mockResolvedValueOnce({
        quoteHash: "sha256:coupon-applied",
        financialSummary: {
          subtotal: 100_000,
          discount: 10_000,
          tax: 0,
          shipping: 20_000,
          total: 110_000,
        },
      })
      .mockResolvedValueOnce({
        quoteHash: "sha256:coupon-removed",
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
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
    });
    const first = (CartService.finalizeCart as jest.Mock).mock.calls[0][0] as {
      attemptId: string;
      quoteHash: string;
      discountCode?: string;
    };
    expect(first.quoteHash).toBe("sha256:undiscounted");
    expect(first.discountCode).toBeFalsy();
    window.localStorage.setItem("pendingCheckoutOrderId", "91");

    fireEvent.click(screen.getByTestId("apply-discount"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(2);
    });
    const discounted = (CartService.finalizeCart as jest.Mock).mock.calls[1][0] as {
      attemptId: string;
      quoteHash: string;
      discountCode?: string;
    };
    expect(discounted.attemptId).not.toBe(first.attemptId);
    expect(discounted.quoteHash).toBe("sha256:coupon-applied");
    expect(discounted.discountCode).toBe("SUMMER");
    expect(window.localStorage.getItem("continuableCheckoutAttemptId")).toBe(first.attemptId);
    expect(window.localStorage.getItem("continuableCheckoutQuoteHash")).toBe("sha256:undiscounted");

    fireEvent.click(screen.getByTestId("remove-discount"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(3);
    });
    const removed = (CartService.finalizeCart as jest.Mock).mock.calls[2][0] as {
      attemptId: string;
      quoteHash: string;
      discountCode?: string;
    };
    expect(removed.attemptId).not.toBe(first.attemptId);
    expect(removed.attemptId).not.toBe(discounted.attemptId);
    expect(removed.quoteHash).toBe("sha256:coupon-removed");
    expect(removed.discountCode).toBeFalsy();
  });

  it("mints a new attempt when only shipping changes on an unpaid checkout", async () => {
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue(["mellat"]);
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: ["mellat"],
      paymentCapabilities: {
        walletEnabled: ["mellat"].includes("wallet"),
        splitEnabled: false,
        splitDisabledReason: "disabled",
        splitGateways: [],
        gatewayMinimumsToman: {},
      },
    });
    (CartService.getCheckoutQuote as jest.Mock)
      .mockResolvedValueOnce({
        quoteHash: "sha256:post-shipping",
        financialSummary: {
          subtotal: 100_000,
          discount: 0,
          tax: 0,
          shipping: 20_000,
          total: 120_000,
        },
      })
      .mockResolvedValueOnce({
        quoteHash: "sha256:express-shipping",
        financialSummary: {
          subtotal: 100_000,
          discount: 0,
          tax: 0,
          shipping: 40_000,
          total: 140_000,
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
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
    });
    const first = (CartService.finalizeCart as jest.Mock).mock.calls[0][0] as {
      attemptId: string;
      quoteHash: string;
      shipping: number;
    };
    expect(first.quoteHash).toBe("sha256:post-shipping");
    expect(first.shipping).toBe(7);
    window.localStorage.setItem("pendingCheckoutOrderId", "91");

    mockCartState = {
      ...mockCartState,
      totalPrice: 100_000,
    };
    fireEvent.click(screen.getByTestId("select-shipping-express"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(2);
    });
    const express = (CartService.finalizeCart as jest.Mock).mock.calls[1][0] as {
      attemptId: string;
      quoteHash: string;
      shipping: number;
    };
    expect(express.attemptId).not.toBe(first.attemptId);
    expect(express.quoteHash).toBe("sha256:express-shipping");
    expect(express.shipping).toBe(8);
  });
});
