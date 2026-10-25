import React from "react";
import { webcrypto } from "node:crypto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import ShoppingCartBillForm from ".";
import { currentUserAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { CartService } from "@/services";
import { AUTH_STATE_EVENT } from "@repo/auth-core/contracts";
import { readAuthStateVersion } from "@/lib/central-auth";
import WalletService from "@/services/wallet";

const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn() }),
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: Object.assign(jest.fn(), { error: jest.fn(), success: jest.fn() }),
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
  readAuthStateVersion: jest.fn(() => 0),
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

let mockIsCartReady = true;

jest.mock("@/contexts/CartContext", () => ({
  useCart: () => ({
    ...mockCartState,
    isCartReady: mockIsCartReady,
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
    getCheckoutAttempt: jest.fn().mockResolvedValue({ success: true, lookup: "missing" }),
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
  trackCheckoutFailure: jest.fn(),
  checkoutFailureCategoryForCode: jest.fn(() => "unknown"),
}));

jest.mock("./InformationForm", () => ({
  __esModule: true,
  default: ({ setValue }: any) => (
    <div data-testid="checkout-information-form">
      <button
        type="button"
        data-testid="select-checkout-customer"
        onClick={() => {
          setValue("fullName", "حدیث شعبانی");
          setValue("phoneNumber", "09123456789");
          setValue("address", { id: 5, label: "Test address" });
        }}
      >
        select customer
      </button>
      <button type="button" data-testid="change-checkout-notes" onClick={() => setValue("notes", "changed note")}>change notes</button>
      <button type="button" data-testid="change-checkout-address" onClick={() => setValue("address", { id: 99, label: "Other address" })}>change address</button>
    </div>
  ),
}));

jest.mock("./DeliveryForm", () => ({
  __esModule: true,
  default: ({ setValue, walletTender }: any) => (
    <div data-testid="checkout-delivery-form">
      {walletTender}
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
  default: ({
    availableGateways,
    onChange,
    snappEligible,
    walletAvailableIrr,
    snappBlockedByWalletSplit,
  }: any) => (
    <div
      data-testid="checkout-payment-gateway"
      data-snapp-eligible={String(snappEligible)}
      data-wallet-available-irr={String(walletAvailableIrr ?? 0)}
      data-snapp-blocked-by-wallet-split={String(Boolean(snappBlockedByWalletSplit))}
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
    mockIsCartReady = true;
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
    jest.mocked(readAuthStateVersion).mockReturnValue(0);
    (CartService.getCheckoutAttempt as jest.Mock).mockReset().mockResolvedValue({ success: true, lookup: "missing" });
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

  it("waits for the post-login cart merge before checking stock or pricing a restored discount", async () => {
    localStorage.setItem("discountCode", "RESTORED10");
    mockIsCartReady = false;
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
    await act(async () => {
      await Promise.resolve();
    });
    expect(CartService.checkCartStock).not.toHaveBeenCalled();
    expect(CartService.applyDiscount).not.toHaveBeenCalled();

    // CartProvider finished merging the guest cart (or gave up — it flips either way).
    mockIsCartReady = true;
    rerender(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() => {
      expect(CartService.checkCartStock).toHaveBeenCalledTimes(1);
      expect(CartService.applyDiscount).toHaveBeenCalledWith(
        expect.objectContaining({ code: "RESTORED10" }),
      );
    });
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
    // The typed recipient travels with a saved address too, so the order doesn't
    // show whoever that address was first used for.
    const recipient = { FullName: "حدیث شعبانی", Phone: "09123456789" };
    expect(CartService.getCheckoutQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        shipping: 7,
        addressId: 5,
        recipient,
        gateway: "snappay",
        mobile: "09123456789",
      }),
    );
    expect(CartService.finalizeCart).toHaveBeenCalledWith(
      expect.objectContaining({
        shipping: 7,
        addressId: 5,
        recipient,
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
    expect(screen.getByTestId("checkout-submit")).toBeDisabled();
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
    // 120,000 toman of order against 500,000 toman of spendable credit.
    (WalletService.getMyWallet as jest.Mock).mockResolvedValue({
      success: true,
      data: { balance: 5_000_000, heldBalance: 0, availableBalance: 5_000_000 },
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

    await waitFor(() =>
      expect(screen.getByTestId("select-checkout-customer")).toBeVisible(),
    );
    fireEvent.click(screen.getByTestId("select-checkout-customer"));
    fireEvent.click(screen.getByTestId("select-shipping"));
    // Ticking the wallet is the whole choice: it spends as much of the order
    // as the shopper has, which here is all of it, so no bank is involved.
    await waitFor(() =>
      expect(screen.getByTestId("wallet-contribution-toggle")).toBeVisible(),
    );
    fireEvent.click(screen.getByTestId("wallet-contribution-toggle"));
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/payment/result?orderId=88");
    });
    expect((CartService.finalizeCart as jest.Mock).mock.calls.at(-1)?.[0]).toMatchObject({
      gateway: "wallet",
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
        "data-wallet-available-irr",
        "0",
      );
    });
  });

  it("names the predecessor on a wallet-only checkout, not just a partial one", async () => {
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
    // Everything is held by the shopper's own earlier attempt, and all of it is
    // reclaimable — which is what makes the wallet-only card offerable at all.
    (WalletService.getMyWallet as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        balance: 1_200_000,
        heldBalance: 1_200_000,
        availableBalance: 0,
        reusableBalance: 1_200_000,
      },
    });
    (CartService.getCheckoutQuote as jest.Mock).mockResolvedValue({
      quoteHash: "sha256:wallet-only-quote",
      financialSummary: { subtotal: 100_000, discount: 0, tax: 0, shipping: 20_000, total: 120_000 },
    });
    (CartService.finalizeCart as jest.Mock).mockResolvedValue({
      success: true,
      orderId: 91,
      redirectUrl: "",
      paymentStatus: "Succeeded",
    });
    window.localStorage.setItem("pendingCheckoutAttemptId", "attempt-being-replaced");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:older-quote");

    const store = createStore();
    store.set(currentUserAtom, { id: 1 });
    store.set(userLoadingAtom, false);

    render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("select-checkout-customer")).toBeVisible(),
    );
    fireEvent.click(screen.getByTestId("select-checkout-customer"));
    fireEvent.click(screen.getByTestId("select-shipping"));
    // Credit covers the whole order, so this is a wallet-only checkout and the
    // server still needs the predecessor named to hand its hold back.
    await waitFor(() =>
      expect(screen.getByTestId("wallet-contribution-toggle")).toBeVisible(),
    );
    fireEvent.click(screen.getByTestId("wallet-contribution-toggle"));
    fireEvent.click(screen.getByTestId("checkout-accept-terms"));
    fireEvent.click(screen.getByTestId("checkout-submit"));

    await waitFor(() => expect(CartService.getCheckoutQuote).toHaveBeenCalled());
    const quotePayload = (CartService.getCheckoutQuote as jest.Mock).mock.calls.at(-1)?.[0];
    expect(quotePayload).toMatchObject({
      gateway: "wallet",
      supersedeAttemptId: "attempt-being-replaced",
      // The whole order, stated explicitly, so the server resolves the same
      // wallet-only allocation the card just showed the shopper.
      walletAmountToman: 120_000,
    });

    await waitFor(() => expect(CartService.finalizeCart).toHaveBeenCalled());
    expect((CartService.finalizeCart as jest.Mock).mock.calls.at(-1)?.[0]).toMatchObject({
      supersedeAttemptId: "attempt-being-replaced",
    });
  });

  it("re-reads the wallet when bfcache restores the page after a gateway trip", async () => {
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
    // Read before the shopper left for the bank: their credit is committed to
    // the attempt they are about to abandon, so nothing is spendable and the
    // contribution card hides itself.
    (WalletService.getMyWallet as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        balance: 1_200_000,
        heldBalance: 1_200_000,
        availableBalance: 0,
        reusableBalance: 0,
      },
    });
    window.localStorage.setItem("pendingCheckoutAttemptId", "attempt-abandoned-at-bank");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:abandoned-quote");

    const store = createStore();
    store.set(currentUserAtom, { id: 1 });
    store.set(userLoadingAtom, false);

    render(
      <Provider store={store}>
        <ShoppingCartBillForm />
      </Provider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("select-checkout-customer")).toBeVisible(),
    );
    fireEvent.click(screen.getByTestId("select-checkout-customer"));
    fireEvent.click(screen.getByTestId("select-shipping"));
    await waitFor(() => expect(WalletService.getMyWallet).toHaveBeenCalled());
    expect(screen.queryByTestId("wallet-contribution-toggle")).toBeNull();

    // They pressed back at the bank. The server now counts that attempt's hold
    // as theirs to reclaim, but bfcache does not remount, so without an
    // explicit re-read the card would stay hidden on a stale zero.
    (WalletService.getMyWallet as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        balance: 1_200_000,
        heldBalance: 1_200_000,
        availableBalance: 0,
        reusableBalance: 1_200_000,
      },
    });
    (WalletService.getMyWallet as jest.Mock).mockClear();

    await act(async () => {
      const persisted = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(persisted, "persisted", { value: true });
      window.dispatchEvent(persisted);
    });

    await waitFor(() =>
      expect(WalletService.getMyWallet).toHaveBeenCalledWith("attempt-abandoned-at-bank"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("wallet-contribution-toggle")).toBeVisible(),
    );
  });

  it("re-asks SnappPay about the gateway leg when the wallet is ticked", async () => {
    // Wallet credit is a tender, not a discount: the order total does not move
    // when the box is ticked, so keying the eligibility check on the total left
    // SnappPay answering about an amount it would never be charged.
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue([
      "wallet",
      "snappay",
      "mellat",
    ]);
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: ["wallet", "snappay", "mellat"],
      paymentCapabilities: {
        walletEnabled: true,
        splitEnabled: true,
        splitDisabledReason: null,
        splitGateways: ["mellat", "snappay"],
        gatewayMinimumsToman: { mellat: 1000, snappay: 1000 },
      },
    });
    (CartService.getSnappEligible as jest.Mock).mockResolvedValue({ eligible: true });
    // 40,000 toman of credit against a 100,000 toman order.
    (WalletService.getMyWallet as jest.Mock).mockResolvedValue({
      success: true,
      data: { balance: 400_000, heldBalance: 0, availableBalance: 400_000 },
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
      expect(CartService.getSnappEligible).toHaveBeenCalledTimes(1);
    });
    expect(CartService.getSnappEligible).toHaveBeenLastCalledWith({ amount: 100_000 });

    await waitFor(() =>
      expect(screen.getByTestId("wallet-contribution-toggle")).toBeVisible(),
    );
    fireEvent.click(screen.getByTestId("wallet-contribution-toggle"));

    await waitFor(() => {
      expect(CartService.getSnappEligible).toHaveBeenCalledTimes(2);
    });
    // 100,000 total - 40,000 wallet: the leg the server checks at the quote.
    expect(CartService.getSnappEligible).toHaveBeenLastCalledWith({ amount: 60_000 });

    fireEvent.click(screen.getByTestId("wallet-contribution-toggle"));

    await waitFor(() => {
      expect(CartService.getSnappEligible).toHaveBeenCalledTimes(3);
    });
    expect(CartService.getSnappEligible).toHaveBeenLastCalledWith({ amount: 100_000 });
  });

  it("withholds SnappPay instead of asking about a split the server refuses", async () => {
    // `splitGateways` without snappay is the server saying it will refuse the
    // combination with WALLET_SPLIT_UNSUPPORTED_GATEWAY before any eligibility
    // call — so there is nothing to ask, and nothing to offer.
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue([
      "wallet",
      "snappay",
      "mellat",
    ]);
    (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
      gateways: ["wallet", "snappay", "mellat"],
      paymentCapabilities: {
        walletEnabled: true,
        splitEnabled: true,
        splitDisabledReason: null,
        splitGateways: ["mellat"],
        gatewayMinimumsToman: { mellat: 1000 },
      },
    });
    (CartService.getSnappEligible as jest.Mock).mockResolvedValue({ eligible: true });
    (WalletService.getMyWallet as jest.Mock).mockResolvedValue({
      success: true,
      data: { balance: 400_000, heldBalance: 0, availableBalance: 400_000 },
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
      expect(CartService.getSnappEligible).toHaveBeenCalledTimes(1);
    });

    await waitFor(() =>
      expect(screen.getByTestId("wallet-contribution-toggle")).toBeVisible(),
    );
    fireEvent.click(screen.getByTestId("wallet-contribution-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("checkout-payment-gateway")).toHaveAttribute(
        "data-snapp-blocked-by-wallet-split",
        "true",
      );
    });
    // Settled "no", not "unknown": this is what takes the card out of the
    // selectable list so a bank is picked instead.
    expect(screen.getByTestId("checkout-payment-gateway")).toHaveAttribute(
      "data-snapp-eligible",
      "false",
    );
    expect(CartService.getSnappEligible).toHaveBeenCalledTimes(1);
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

  it("checks an unknown checkout without replaying finalize when the attempt is not yet visible", async () => {
    window.localStorage.setItem("pendingCheckoutAttemptId", "live-attempt");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:failing-quote");
    await submitCheckoutWithError("PAYMENT_UNKNOWN");

    await waitFor(() => {
      expect(screen.getByTestId("checkout-error-retry")).toBeVisible();
    });
    expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("checkout-error-retry"));

    await waitFor(() => expect(CartService.getCheckoutAttempt).toHaveBeenCalledWith("live-attempt"));
    expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
    expect(CartService.getCheckoutQuote).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("pendingCheckoutQuoteHash")).toBe("sha256:failing-quote");
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

  it("keeps the stored attempt and reports an unowned reservation lookup failure", async () => {
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
    expect(captureCheckoutMessage).toHaveBeenCalledTimes(1);
    expect(captureCheckoutMessage).toHaveBeenCalledWith(
      "checkout.error:RESERVATION_LOOKUP_FAILED",
      expect.objectContaining({ level: "error" }),
    );
  });

  it("keeps the stored attempt without duplicating a backend-owned reservation lookup failure", async () => {
    window.localStorage.setItem("pendingCheckoutAttemptId", "live-attempt");
    window.localStorage.setItem("pendingCheckoutQuoteHash", "sha256:failing-quote");
    await submitCheckoutWithError("RESERVATION_LOOKUP_FAILED", { telemetryOwner: "backend" });

    await waitFor(() => {
      expect(screen.getByTestId("checkout-form-error")).toHaveTextContent("دوباره تلاش کنید");
    });
    expect(window.localStorage.getItem("pendingCheckoutAttemptId")).toBe("live-attempt");
    expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
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
      errorCode: "SHIPPING_VALIDATION_FAILED",
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
      errorCode: "SHIPPING_VALIDATION_FAILED",
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

  describe("payment navigation and unanswered finalize recovery", () => {
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    beforeEach(() => {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
      jest.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => undefined);
      (CartService.getCheckoutQuote as jest.Mock).mockReset().mockResolvedValue({
        quoteHash: "sha256:handoff",
        financialSummary: { total: 120_000 },
      });
      (CartService.finalizeCart as jest.Mock).mockReset().mockResolvedValue({
        success: true, orderId: 91, redirectUrl: "https://bank.example/pay", redirectMethod: "POST", formFields: { RefId: "opaque-reference" },
      });
    });
    afterEach(() => {
      if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
      jest.requireMock("@/lib/analytics").getAnalyticsCorrelationId.mockReturnValue("guest-test-correlation");
      jest.restoreAllMocks();
      jest.useRealTimers();
    });
    async function prepareCheckout() {
      const store = createStore();
      store.set(currentUserAtom, { id: 1 });
      store.set(userLoadingAtom, false);
      const view = render(<Provider store={store}><ShoppingCartBillForm /></Provider>);
      await waitFor(() => expect(screen.getByTestId("checkout-submit")).toBeVisible());
      fireEvent.click(screen.getByTestId("select-checkout-customer"));
      fireEvent.click(screen.getByTestId("select-shipping"));
      fireEvent.click(screen.getByTestId("checkout-accept-terms"));
      return { ...view, store };
    }
    const foundAttempt = () => ({
      success: true, lookup: "found", attempt: {
        attemptId: localStorage.getItem("pendingCheckoutAttemptId"), quoteHash: "sha256:handoff", orderId: 91, status: "Redirected",
      },
    });

    it("holds the submit guard after POST handoff, ordinary pageshow and pagehide", async () => {
      const view = await prepareCheckout();
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await waitFor(() => expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("checkout-submit")).toBeDisabled();
      window.dispatchEvent(new Event("pageshow"));
      window.dispatchEvent(new Event("pagehide"));
      expect(screen.getByTestId("checkout-submit")).toBeDisabled();
      fireEvent.submit(view.container.querySelector("form")!);
      await act(async () => { await Promise.resolve(); });
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
    });

    it("sends a stalled navigation to the known order after ten visible seconds without finalizing again", async () => {
      jest.useFakeTimers();
      await prepareCheckout();
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await waitFor(() => expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1));
      await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
      expect(mockPush).toHaveBeenCalledWith("/payment/result?orderId=91");
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("checkout-submit")).toBeDisabled();
    });

    it("unlocks a persisted pageshow and checks the old order before another payment", async () => {
      await prepareCheckout();
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await waitFor(() => expect(HTMLFormElement.prototype.submit).toHaveBeenCalled());
      (CartService.getCheckoutAttempt as jest.Mock).mockResolvedValue(foundAttempt());
      const restored = new Event("pageshow");
      Object.defineProperty(restored, "persisted", { value: true });
      act(() => { window.dispatchEvent(restored); });
      expect(screen.getByTestId("checkout-submit")).toBeEnabled();
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/payment/result?orderId=91"));
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
    });

    it.each(["incomplete", "blocked"])("opens the known order when the POST handoff is %s", async (failure) => {
      if (failure === "incomplete") {
        (CartService.finalizeCart as jest.Mock).mockResolvedValue({ success: true, orderId: 91, redirectUrl: "https://bank.example/pay", redirectMethod: "POST", formFields: {} });
      } else {
        jest.mocked(HTMLFormElement.prototype.submit).mockImplementationOnce(() => { throw new Error("navigation blocked"); });
      }
      await prepareCheckout();
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/payment/result?orderId=91"));
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("checkout-submit")).toBeDisabled();
    });

    it("reconstructs only an identical request after reload and replays the same attempt after a missing lookup", async () => {
      (CartService.finalizeCart as jest.Mock).mockRejectedValue(new TypeError("connection lost"));
      const first = await prepareCheckout();
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await screen.findByTestId("checkout-form-error");
      const attemptId = localStorage.getItem("pendingCheckoutAttemptId");
      first.unmount();
      jest.requireMock("@/lib/analytics").getAnalyticsCorrelationId.mockReturnValue("reloaded-correlation");
      await prepareCheckout();
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await screen.findByTestId("checkout-form-error");
      expect(CartService.getCheckoutAttempt).toHaveBeenCalledWith(attemptId);
      expect(CartService.getCheckoutQuote).toHaveBeenCalledTimes(1);
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(2);
      expect((CartService.finalizeCart as jest.Mock).mock.calls[1][0]).toEqual({
        ...(CartService.finalizeCart as jest.Mock).mock.calls[0][0], analyticsCorrelationId: "reloaded-correlation",
      });
      expect(localStorage.getItem("pendingCheckoutAttemptId")).toBe(attemptId);
      expect(localStorage.getItem("pendingCheckoutQuoteHash")).toBe("sha256:handoff");
      (CartService.getCheckoutAttempt as jest.Mock).mockResolvedValue(foundAttempt());
      fireEvent.click(screen.getByTestId("checkout-error-retry"));
      await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/payment/result?orderId=91"));
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(2);
    });

    it.each([
      { success: true, lookup: "found", attempt: { attemptId: "mismatch", quoteHash: "sha256:handoff", status: "Unknown" } },
      { success: false, lookup: "unavailable" },
    ])("blocks another finalize for an unresolved lookup %j", async (lookup) => {
      (CartService.finalizeCart as jest.Mock).mockRejectedValue(new TypeError("connection lost"));
      await prepareCheckout();
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await screen.findByTestId("checkout-form-error");
      (CartService.getCheckoutAttempt as jest.Mock).mockResolvedValue(lookup);
      fireEvent.click(screen.getByTestId("checkout-error-retry"));
      await waitFor(() => expect(screen.getByTestId("checkout-form-error")).toHaveTextContent("نتیجه پرداخت قبلی هنوز مشخص نیست"));
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem("pendingCheckoutFinalization")).toBeTruthy();
    });

    it.each(["change-checkout-notes", "change-checkout-address"])("keeps a locally cancelled unresolved attempt when %s changes", async (control) => {
      (CartService.finalizeCart as jest.Mock).mockRejectedValue(new TypeError("connection lost"));
      await prepareCheckout();
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await screen.findByTestId("checkout-form-error");
      const attemptId = localStorage.getItem("pendingCheckoutAttemptId");
      (CartService.getCheckoutAttempt as jest.Mock).mockResolvedValue({ success: true, lookup: "found", attempt: {
        attemptId, quoteHash: "sha256:handoff", status: "Cancelled",
      } });
      fireEvent.click(screen.getByTestId(control));
      fireEvent.click(screen.getByTestId("checkout-error-retry"));
      await waitFor(() => expect(screen.getByTestId("checkout-form-error")).toHaveTextContent("نتیجه پرداخت قبلی هنوز مشخص نیست"));
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
      expect(CartService.getCheckoutQuote).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem("pendingCheckoutAttemptId")).toBe(attemptId);
      expect(localStorage.getItem("pendingCheckoutFinalization")).toBeTruthy();
    });

    it("fails closed when a reload changes the recipient or cryptographic hashing is unavailable", async () => {
      (CartService.finalizeCart as jest.Mock).mockRejectedValue(new TypeError("connection lost"));
      const first = await prepareCheckout();
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await screen.findByTestId("checkout-form-error");
      const marker = localStorage.getItem("pendingCheckoutFinalization")!;
      expect(marker).not.toContain("09123456789");
      expect(marker).not.toContain("حدیث");
      first.unmount();
      await prepareCheckout();
      fireEvent.click(screen.getByTestId("change-checkout-address"));
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await screen.findByTestId("checkout-form-error");
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
      fireEvent.click(screen.getByTestId("select-checkout-customer"));
      fireEvent.click(screen.getByTestId("checkout-error-retry"));
      await waitFor(() => expect(screen.getByTestId("checkout-form-error")).toHaveTextContent("نتیجه پرداخت قبلی هنوز مشخص نیست"));
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
    });

    it("discards a late lookup and marker after logout", async () => {
      (CartService.finalizeCart as jest.Mock).mockRejectedValue(new TypeError("connection lost"));
      await prepareCheckout();
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await screen.findByTestId("checkout-form-error");
      let resolve!: (value: unknown) => void;
      (CartService.getCheckoutAttempt as jest.Mock).mockImplementation(() => new Promise((r) => { resolve = r; }));
      fireEvent.click(screen.getByTestId("checkout-error-retry"));
      await waitFor(() => expect(CartService.getCheckoutAttempt).toHaveBeenCalled());
      const result = foundAttempt();
      act(() => {
        jest.mocked(readAuthStateVersion).mockReturnValue(1);
        window.dispatchEvent(new CustomEvent(AUTH_STATE_EVENT, { detail: { type: "logout", at: Date.now() } }));
      });
      await act(async () => resolve(result));
      expect(mockPush).not.toHaveBeenCalled();
      expect(localStorage.getItem("pendingCheckoutFinalization")).toBeNull();
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
    });

    it("retains the original identity after replay 409 and never re-quotes a new attempt", async () => {
      (CartService.finalizeCart as jest.Mock)
        .mockRejectedValueOnce(new TypeError("response lost while original is still running"))
        .mockRejectedValue({ status: 409, errorCode: "CHECKOUT_QUOTE_CHANGED", data: {
          errorCode: "CHECKOUT_QUOTE_CHANGED", quote: { quoteHash: "sha256:new", financialSummary: { total: 130_000 } },
        } });
      await prepareCheckout();
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await screen.findByTestId("checkout-form-error");
      const original = (CartService.finalizeCart as jest.Mock).mock.calls[0][0];
      fireEvent.click(screen.getByTestId("checkout-error-retry"));
      await waitFor(() => expect(CartService.finalizeCart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByTestId("checkout-submit")).toBeEnabled());
      expect(localStorage.getItem("pendingCheckoutFinalization")).toBeTruthy();
      expect(localStorage.getItem("pendingCheckoutAttemptId")).toBe(original.attemptId);
      expect(localStorage.getItem("pendingCheckoutQuoteHash")).toBe(original.quoteHash);
      fireEvent.click(screen.getByTestId("checkout-error-retry"));
      await waitFor(() => expect(CartService.finalizeCart).toHaveBeenCalledTimes(3));
      expect((CartService.finalizeCart as jest.Mock).mock.calls.map(([body]) => body)).toEqual([original, original, original]);
      expect(CartService.getCheckoutQuote).toHaveBeenCalledTimes(1);
    });

    it("does not replay a form changed while its lookup is pending", async () => {
      (CartService.finalizeCart as jest.Mock).mockRejectedValue(new TypeError("connection lost"));
      await prepareCheckout();
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await screen.findByTestId("checkout-form-error");
      let resolve!: (value: unknown) => void;
      (CartService.getCheckoutAttempt as jest.Mock).mockImplementation(() => new Promise((r) => { resolve = r; }));
      fireEvent.click(screen.getByTestId("checkout-error-retry"));
      await waitFor(() => expect(CartService.getCheckoutAttempt).toHaveBeenCalled());
      fireEvent.click(screen.getByTestId("change-checkout-notes"));
      await act(async () => resolve({ success: true, lookup: "missing" }));
      await waitFor(() => expect(screen.getByTestId("checkout-form-error")).toHaveTextContent("نتیجه پرداخت قبلی هنوز مشخص نیست"));
      expect(CartService.finalizeCart).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem("pendingCheckoutFinalization")).toBeTruthy();
    });

    it("restores a wallet replacement with the same predecessor after reload", async () => {
      (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({ gateways: ["wallet", "mellat"], paymentCapabilities: {
        walletEnabled: true, splitEnabled: true, splitDisabledReason: null, splitGateways: ["mellat"], gatewayMinimumsToman: { mellat: 1_000 },
      } });
      (WalletService.getMyWallet as jest.Mock).mockResolvedValue({ success: true, data: {
        balance: 1_200_000, heldBalance: 1_200_000, availableBalance: 0, reusableBalance: 1_200_000,
      } });
      localStorage.setItem("pendingCheckoutAttemptId", "original-wallet-attempt");
      localStorage.setItem("pendingCheckoutQuoteHash", "sha256:old-wallet");
      (CartService.finalizeCart as jest.Mock).mockRejectedValue(new TypeError("connection lost"));
      const first = await prepareCheckout();
      await waitFor(() => expect(screen.getByTestId("wallet-contribution-toggle")).toBeVisible());
      fireEvent.click(screen.getByTestId("wallet-contribution-toggle"));
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await screen.findByTestId("checkout-form-error");
      const original = (CartService.finalizeCart as jest.Mock).mock.calls[0][0];
      expect(original.supersedeAttemptId).toBe("original-wallet-attempt");
      first.unmount();
      await prepareCheckout();
      await waitFor(() => expect(screen.getByTestId("wallet-contribution-toggle")).toBeVisible());
      fireEvent.click(screen.getByTestId("wallet-contribution-toggle"));
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await waitFor(() => expect(CartService.finalizeCart).toHaveBeenCalledTimes(2));
      expect((CartService.finalizeCart as jest.Mock).mock.calls[1][0]).toEqual(original);
      expect(CartService.getCheckoutQuote).toHaveBeenCalledTimes(1);
    });

    it("does not let an older stock poll erase a newer unanswered finalize", async () => {
      let resolveStock!: (value: unknown) => void;
      (CartService.checkCartStock as jest.Mock)
        .mockImplementationOnce(() => new Promise((resolve) => { resolveStock = resolve; }))
        .mockResolvedValue({ valid: true });
      (CartService.finalizeCart as jest.Mock).mockRejectedValue(new TypeError("connection lost"));
      await prepareCheckout();
      await waitFor(() => expect(CartService.checkCartStock).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByTestId("checkout-submit"));
      await screen.findByTestId("checkout-form-error");
      const attemptId = localStorage.getItem("pendingCheckoutAttemptId");
      await act(async () => resolveStock({ valid: true, reservationOutcome: "expired" }));
      expect(localStorage.getItem("pendingCheckoutAttemptId")).toBe(attemptId);
      expect(localStorage.getItem("pendingCheckoutFinalization")).toBeTruthy();
      fireEvent.click(screen.getByTestId("checkout-error-retry"));
      await waitFor(() => expect(CartService.finalizeCart).toHaveBeenCalledTimes(2));
      expect((CartService.finalizeCart as jest.Mock).mock.calls[1][0]).toEqual((CartService.finalizeCart as jest.Mock).mock.calls[0][0]);
    });
  });

  describe("analytics", () => {
    const analyticsMock = jest.requireMock("@/lib/analytics") as {
      trackFunnelStep: jest.Mock;
      trackAnalyticsEvent: jest.Mock;
      trackCheckoutFailure: jest.Mock;
    };
    const actions = () =>
      analyticsMock.trackAnalyticsEvent.mock.calls.map(([event]) => event.action);

    async function renderSignedIn() {
      const store = createStore();
      store.set(currentUserAtom, { id: 1 });
      store.set(userLoadingAtom, false);
      render(
        <Provider store={store}>
          <ShoppingCartBillForm />
        </Provider>,
      );
      await waitFor(() => expect(screen.getByTestId("checkout-submit")).toBeVisible());
    }

    it("counts begin_checkout once per visit and add_payment_info only for an explicit choice", async () => {
      (CartService.getCheckoutPaymentOptions as jest.Mock).mockResolvedValue({
        gateways: ["samankish", "mellat"],
        paymentCapabilities: {
          walletEnabled: false,
          splitEnabled: false,
          splitDisabledReason: "disabled",
          splitGateways: [],
          gatewayMinimumsToman: {},
        },
      });
      await renderSignedIn();
      await waitFor(() => expect(screen.getByTestId("select-mellat")).toBeInTheDocument());

      const beginCheckouts = analyticsMock.trackFunnelStep.mock.calls.filter(
        ([step]) => step === "begin_checkout",
      );
      expect(beginCheckouts).toHaveLength(1);
      // The default gateway is not the shopper's action.
      expect(actions()).not.toContain("add_payment_info");

      fireEvent.click(screen.getByTestId("select-mellat"));
      fireEvent.click(screen.getByTestId("select-mellat"));
      expect(analyticsMock.trackAnalyticsEvent.mock.calls.filter(([e]) => e.action === "add_payment_info"))
        .toEqual([[expect.objectContaining({ properties: { gateway: "mellat" } })]]);

      fireEvent.click(screen.getByTestId("select-shipping"));
      fireEvent.click(screen.getByTestId("select-checkout-customer"));
      await waitFor(() => expect(actions()).toContain("add_shipping_info"));
      expect(analyticsMock.trackFunnelStep.mock.calls.filter(([step]) => step === "begin_checkout"))
        .toHaveLength(1);
    });

    it("reports a validation failure and emits no later checkout event", async () => {
      await renderSignedIn();
      fireEvent.click(screen.getByTestId("select-checkout-customer"));
      fireEvent.click(screen.getByTestId("select-shipping"));
      fireEvent.click(screen.getByTestId("checkout-submit"));

      await waitFor(() =>
        expect(analyticsMock.trackCheckoutFailure).toHaveBeenCalledWith("validation", "samankish"),
      );
      expect(actions()).not.toContain("place_order_attempt");
      expect(actions()).not.toContain("payment_redirect");
      expect(CartService.finalizeCart).not.toHaveBeenCalled();
      // A fixable form error is analytics only, never a Sentry event.
      expect(captureCheckoutMessage).not.toHaveBeenCalled();
    });
  });
});
