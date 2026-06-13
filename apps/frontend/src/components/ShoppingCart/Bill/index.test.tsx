import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import ShoppingCartBillForm from ".";
import { currentUserAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { ACCESS_TOKEN_STORAGE_KEY } from "@/utils/accessToken";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));

jest.mock("@/contexts/CartContext", () => ({
  useCart: () => ({
    totalPrice: 100_000,
    totalItems: 1,
    clearCart: jest.fn(),
  }),
}));

jest.mock("@/services", () => ({
  CartService: {
    getAvailableGateways: jest.fn().mockResolvedValue(["samankish"]),
    getSnappEligible: jest.fn().mockResolvedValue({ eligible: false }),
    applyDiscount: jest.fn(),
    checkCartStock: jest.fn().mockResolvedValue({ valid: true }),
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

jest.mock("@/lib/analytics/matomo", () => ({
  trackFunnelStep: jest.fn(),
  trackMatomoEvent: jest.fn(),
}));

jest.mock("./InformationForm", () => ({
  __esModule: true,
  default: () => <div data-testid="checkout-information-form" />,
}));

jest.mock("./DeliveryForm", () => ({
  __esModule: true,
  default: () => <div data-testid="checkout-delivery-form" />,
}));

jest.mock("./DiscountCoupon", () => ({
  __esModule: true,
  default: () => <div data-testid="checkout-discount-coupon" />,
}));

jest.mock("./PaymentGateway", () => ({
  __esModule: true,
  default: () => <div data-testid="checkout-payment-gateway" />,
}));

jest.mock("./ReserveShipping", () => ({
  __esModule: true,
  default: () => <div data-testid="checkout-reserve-shipping" />,
}));

describe("ShoppingCartBillForm auth gate", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.pushState({}, "", "/checkout");
  });

  it("keeps the auth gate during initial token hydration and reveals the form once auth loading settles", async () => {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "e2e-token");

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
});
