import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import ShoppingCartBillForm from ".";
import { currentUserAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { CartService, OrderService } from "@/services";

/**
 * Reserve checkout (Case A / Case B).
 *
 * The sibling `index.test.tsx` mocks the reserve UI away, so nothing exercised
 * the combined-shipping path. These tests deliberately render the real reserve
 * components -- the feature now ships enabled by default.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));

jest.mock("@/lib/central-auth", () => ({
  centralAuth: { tokenManager: { getToken: jest.fn().mockResolvedValue("token") } },
  centralLoginUrl: jest.fn(() => "http://localhost:2889/auth"),
  readAuthStateVersion: jest.fn(() => 0),
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

// Kept as a stub so the `hideAddressFields` contract is observable; the real
// component's own hiding behaviour is covered in InformationForm.test.tsx.
jest.mock("./InformationForm", () => ({
  __esModule: true,
  default: ({ setValue, hideAddressFields }: any) => (
    <div data-testid="checkout-information-form" data-hide-address={String(!!hideAddressFields)}>
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

jest.mock("./DiscountCoupon", () => ({ __esModule: true, default: () => <div /> }));
jest.mock("./PaymentGateway", () => ({ __esModule: true, default: () => <div /> }));

const HOUR = 3_600_000;

const activeReserve = (overrides: Record<string, unknown> = {}) => ({
  data: {
    reserveGroupId: "grp-1",
    reserveExpiresAt: new Date(Date.now() + 20 * HOUR).toISOString(),
    orders: [],
    orderCount: 2,
    shippingCostPaid: 20_000,
    shippingMethodTitle: "پست پیشتاز",
    deliveryAddress: {
      FullAddress: "خیابان آزادی، پلاک ۱",
      shipping_city: { Title: "تهران", shipping_province: { Title: "تهران" } },
    },
    lastOrderAttachedAt: null,
    rootOrderId: 41,
    ...overrides,
  },
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

const readyForm = async () => {
  await waitFor(() => expect(screen.getByTestId("checkout-submit")).toBeVisible());
};

describe("reserve checkout", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
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
    (OrderService.getActiveReserve as jest.Mock).mockResolvedValue({ data: null });
  });

  describe("Case A -- no open window", () => {
    it("offers the 48h option and explains that later orders ship free", async () => {
      renderCheckout();
      await readyForm();

      const option = await screen.findByRole("switch", { name: /ارسال رزروی ۴۸ ساعته/ });
      expect(option).toHaveAttribute("aria-checked", "false");

      fireEvent.click(option);

      expect(option).toHaveAttribute("aria-checked", "true");
      // The promise is stated as a number on the card, not only in prose.
      const laterOrdersRow = screen.getByText("هزینه ارسال سفارش‌های بعدی").closest("span")
        ?.parentElement;
      expect(laterOrdersRow).toHaveTextContent("۰ تومان");
      expect(screen.getByText(/مهلت افزودن سفارش، حدوداً تا/)).toBeInTheDocument();
    });
  });

  describe("Case B -- an open window exists", () => {
    beforeEach(() => {
      (OrderService.getActiveReserve as jest.Mock).mockResolvedValue(activeReserve());
    });

    it("presents both fulfillment options with neither pre-selected", async () => {
      renderCheckout();
      await readyForm();

      const merge = await screen.findByRole("button", { name: /افزودن به سفارش رزروی فعال/ });
      const separate = screen.getByRole("button", { name: /ارسال جداگانه/ });

      expect(merge).toHaveAttribute("aria-pressed", "false");
      expect(separate).toHaveAttribute("aria-pressed", "false");
      // Never silently auto-attach.
      expect(screen.queryByTestId("reserve-merge-shipping")).not.toBeInTheDocument();
    });

    it("does not offer opening a second window", async () => {
      renderCheckout();
      await readyForm();
      await screen.findByRole("button", { name: /افزودن به سفارش رزروی فعال/ });

      expect(screen.queryByRole("switch", { name: /ارسال رزروی ۴۸ ساعته/ })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /ارسال جداگانه/ }));

      expect(
        screen.queryByRole("switch", { name: /ارسال رزروی ۴۸ ساعته/ }),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/نمی‌توانید همزمان بسته رزروی دیگری باز کنید/)).toBeInTheDocument();
    });

    it("shows the inherited destination, hides the address form and charges no shipping", async () => {
      renderCheckout();
      await readyForm();

      fireEvent.click(await screen.findByRole("button", { name: /افزودن به سفارش رزروی فعال/ }));

      expect(screen.getByText(/خیابان آزادی، پلاک ۱/)).toBeInTheDocument();
      expect(screen.getByText("پست پیشتاز")).toBeInTheDocument();
      expect(screen.getByTestId("checkout-information-form")).toHaveAttribute(
        "data-hide-address",
        "true",
      );
      expect(screen.getByTestId("reserve-merge-shipping")).toHaveTextContent("۰ تومان");
      expect(screen.queryByTestId("checkout-delivery-form")).not.toBeInTheDocument();
    });

    it("refuses to submit until the shopper chooses combined or separate shipping", async () => {
      renderCheckout();
      await readyForm();
      await screen.findByRole("button", { name: /افزودن به سفارش رزروی فعال/ });

      fireEvent.click(screen.getByTestId("select-checkout-customer"));
      fireEvent.click(screen.getByTestId("select-shipping"));
      fireEvent.submit(screen.getByTestId("checkout-submit").closest("form")!);

      await waitFor(() =>
        expect(
          screen.getByText("لطفاً مشخص کنید این سفارش به بسته رزروی اضافه شود یا جداگانه ارسال شود"),
        ).toBeInTheDocument(),
      );
      expect(CartService.getCheckoutQuote).not.toHaveBeenCalled();
      expect(CartService.finalizeCart).not.toHaveBeenCalled();
    });

    it("falls back to normal shipping when the window closes on the page", async () => {
      jest.useFakeTimers();
      try {
        (OrderService.getActiveReserve as jest.Mock).mockResolvedValue(
          activeReserve({ reserveExpiresAt: new Date(Date.now() + 20_000).toISOString() }),
        );
        renderCheckout();
        await act(async () => {
          await Promise.resolve();
        });

        expect(
          screen.getByRole("button", { name: /افزودن به سفارش رزروی فعال/ }),
        ).toBeInTheDocument();

        // The component re-reads the clock every 30s; the deadline is 20s out.
        await act(async () => {
          jest.advanceTimersByTime(31_000);
        });

        expect(
          screen.queryByRole("button", { name: /افزودن به سفارش رزروی فعال/ }),
        ).not.toBeInTheDocument();
        expect(screen.getByTestId("reserve-window-closed-notice")).toBeInTheDocument();
        // Normal shipping selection is back, and the cart is untouched.
        expect(screen.getByTestId("checkout-delivery-form")).toBeInTheDocument();
        expect(screen.getByRole("switch", { name: /ارسال رزروی ۴۸ ساعته/ })).toBeInTheDocument();
      } finally {
        jest.useRealTimers();
      }
    });

    it("recovers when the backend rejects a window that closed mid-checkout", async () => {
      (CartService.getCheckoutQuote as jest.Mock).mockResolvedValue({
        quoteHash: "hash-1",
        financialSummary: { total: 100_000 },
      });
      (CartService.finalizeCart as jest.Mock).mockResolvedValue({
        success: false,
        errorCode: "RESERVE_NOT_FOUND",
        message: "reserve window closed",
      });

      renderCheckout();
      await readyForm();

      fireEvent.click(await screen.findByRole("button", { name: /افزودن به سفارش رزروی فعال/ }));
      fireEvent.click(screen.getByTestId("select-checkout-customer"));
      fireEvent.click(screen.getByTestId("checkout-accept-terms"));
      fireEvent.submit(screen.getByTestId("checkout-submit").closest("form")!);

      // The recovery must come from the server's refusal, not from an earlier
      // client-side guard short-circuiting the submit.
      await waitFor(() => expect(CartService.finalizeCart).toHaveBeenCalled());
      await waitFor(() =>
        expect(screen.getByTestId("reserve-window-closed-notice")).toBeInTheDocument(),
      );
      expect(screen.getByText(/مهلت افزودن سفارش به بسته رزروی به پایان رسید/)).toBeInTheDocument();
      expect(screen.getByTestId("checkout-delivery-form")).toBeInTheDocument();
    });
  });

  // An open window whose deadline we cannot read must stay offered. Treating it
  // as expired used to clear activeReserve, which brought the "open a window"
  // switch back AND disabled the submit guard -- so the shopper silently paid
  // shipping twice instead of being asked.
  describe("Case B -- open window with an unreadable deadline", () => {
    beforeEach(() => {
      (OrderService.getActiveReserve as jest.Mock).mockResolvedValue(
        activeReserve({ reserveExpiresAt: null }),
      );
    });

    it("keeps the attach offer and just drops the countdown", async () => {
      renderCheckout();
      await readyForm();

      expect(
        await screen.findByRole("button", { name: /افزودن به سفارش رزروی فعال/ }),
      ).toBeInTheDocument();
      // Not mistaken for a closed window.
      expect(screen.queryByTestId("reserve-window-closed-notice")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("switch", { name: /ارسال رزروی ۴۸ ساعته/ }),
      ).not.toBeInTheDocument();
      // The countdown is omitted rather than rendered as a bogus value.
      expect(screen.queryByText(/باقی مانده/)).not.toBeInTheDocument();
      expect(screen.queryByText(/مهلت افزودن سفارش تا/)).not.toBeInTheDocument();
    });

    it("still refuses to submit until the shopper chooses", async () => {
      renderCheckout();
      await readyForm();
      await screen.findByRole("button", { name: /افزودن به سفارش رزروی فعال/ });

      fireEvent.click(screen.getByTestId("select-checkout-customer"));
      fireEvent.click(screen.getByTestId("select-shipping"));
      fireEvent.submit(screen.getByTestId("checkout-submit").closest("form")!);

      await waitFor(() =>
        expect(
          screen.getByText("لطفاً مشخص کنید این سفارش به بسته رزروی اضافه شود یا جداگانه ارسال شود"),
        ).toBeInTheDocument(),
      );
      expect(CartService.finalizeCart).not.toHaveBeenCalled();
    });
  });

  describe("RESERVE_ALREADY_ACTIVE recovery", () => {
    it("surfaces the attach card instead of naming controls that are not on screen", async () => {
      // The client starts out unaware of the window, so it offers Case A.
      (OrderService.getActiveReserve as jest.Mock)
        .mockResolvedValueOnce({ data: null })
        .mockResolvedValue(activeReserve());
      // Must equal the shopper-visible total (subtotal 100k + shipping 20k),
      // otherwise the quote-review gate consumes the first submit.
      (CartService.getCheckoutQuote as jest.Mock).mockResolvedValue({
        quoteHash: "hash-1",
        financialSummary: { total: 120_000 },
      });
      (CartService.finalizeCart as jest.Mock).mockResolvedValue({
        success: false,
        errorCode: "RESERVE_ALREADY_ACTIVE",
        message: "already active",
        reserveGroupId: "grp-1",
      });

      renderCheckout();
      await readyForm();

      expect(
        await screen.findByRole("switch", { name: /ارسال رزروی ۴۸ ساعته/ }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("select-checkout-customer"));
      fireEvent.click(screen.getByTestId("select-shipping"));
      fireEvent.click(screen.getByTestId("checkout-accept-terms"));
      fireEvent.submit(screen.getByTestId("checkout-submit").closest("form")!);

      await waitFor(() => expect(CartService.finalizeCart).toHaveBeenCalled());
      // Without the refetch the message tells the shopper to use a card that
      // does not exist, and only a page reload recovers.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /افزودن به سفارش رزروی فعال/ }),
        ).toBeInTheDocument(),
      );
      // Match the error's own clause: the card heading reuses the first sentence.
      expect(
        screen.getByText(/این سفارش را به همان بسته اضافه کنید/),
      ).toBeInTheDocument();
    });
  });
});
