import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { currentUserAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { CartService, OrderService } from "@/services";

/**
 * Reserve checkout soft-lock.
 *
 * `NEXT_PUBLIC_INFINITY_RESERVE_CHECKOUT_ENABLED="false"` is the UI-only kill
 * switch (see the flag comment in ./index.tsx). The value is read once at
 * module load, so this file sets it before importing the form instead of
 * sharing ReserveCheckout.test.tsx, which renders the enabled path.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));

jest.mock("@/lib/central-auth", () => ({
  centralAuth: { tokenManager: { getToken: jest.fn().mockResolvedValue("token") } },
  centralLoginUrl: jest.fn(() => "http://localhost:2889/auth"),
}));

jest.mock("@/contexts/CartContext", () => ({
  useCart: () => ({
    totalPrice: 100_000,
    totalItems: 1,
    cartItems: [{ id: "1", cartItemId: "10", variationId: "100", quantity: 1, price: 100_000 }],
    isCartReady: true,
    clearCart: jest.fn(),
    openDrawer: jest.fn(),
    refreshCart: jest.fn(),
    setStockNotice: jest.fn(),
    stockNotice: null,
    dismissStockNotice: jest.fn(),
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
  OrderService: { getActiveReserve: jest.fn() },
}));

jest.mock("@/services/wallet", () => ({
  __esModule: true,
  default: { getMyWallet: jest.fn().mockResolvedValue({ success: true, data: { balance: 0 } }) },
}));

jest.mock("@/lib/analytics", () => ({
  getAnalyticsCorrelationId: jest.fn(() => "test-correlation"),
  trackFunnelStep: jest.fn(),
  trackAnalyticsEvent: jest.fn(),
  trackCheckoutFailure: jest.fn(),
  checkoutFailureCategoryForCode: jest.fn(() => "unknown"),
}));

jest.mock("./InformationForm", () => ({
  __esModule: true,
  default: ({ hideAddressFields }: { hideAddressFields?: boolean }) => (
    <div data-testid="checkout-information-form" data-hide-address={String(!!hideAddressFields)} />
  ),
}));
jest.mock("./DeliveryForm", () => ({ __esModule: true, default: () => <div data-testid="checkout-delivery-form" /> }));
jest.mock("./DiscountCoupon", () => ({ __esModule: true, default: () => <div /> }));
jest.mock("./PaymentGateway", () => ({ __esModule: true, default: () => <div /> }));

let ShoppingCartBillForm: React.ComponentType;
const previousFlag = process.env.NEXT_PUBLIC_INFINITY_RESERVE_CHECKOUT_ENABLED;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_INFINITY_RESERVE_CHECKOUT_ENABLED = "false";
  ShoppingCartBillForm = (await import(".")).default;
});

afterAll(() => {
  if (previousFlag === undefined) delete process.env.NEXT_PUBLIC_INFINITY_RESERVE_CHECKOUT_ENABLED;
  else process.env.NEXT_PUBLIC_INFINITY_RESERVE_CHECKOUT_ENABLED = previousFlag;
});

const renderCheckout = () => {
  const store = createStore();
  store.set(currentUserAtom, { id: 1 } as never);
  store.set(userLoadingAtom, false);
  return render(
    <Provider store={store}>
      <ShoppingCartBillForm />
    </Provider>,
  );
};

describe("reserve checkout disabled by build flag", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
    (CartService.getAvailableGateways as jest.Mock).mockResolvedValue(["samankish"]);
    (CartService.getSnappEligible as jest.Mock).mockResolvedValue({ eligible: false });
    (CartService.checkCartStock as jest.Mock).mockResolvedValue({ valid: true });
  });

  it("never offers the 48h option and never asks the API for an active reserve", async () => {
    renderCheckout();
    await waitFor(() => expect(screen.getByTestId("checkout-submit")).toBeVisible());

    expect(screen.queryByRole("switch", { name: /ارسال رزروی ۴۸ ساعته/ })).not.toBeInTheDocument();
    expect(OrderService.getActiveReserve).not.toHaveBeenCalled();
    // With no reserve context the address form is the normal one.
    expect(screen.getByTestId("checkout-information-form")).toHaveAttribute("data-hide-address", "false");
  });
});
