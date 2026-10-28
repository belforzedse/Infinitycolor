import React from "react";
import { render, screen } from "@testing-library/react";
import type { CartStockNoticeState } from "@/utils/cartStock";

type MockCartItem = { id: string; price: number; quantity: number };
const mockCart: {
  cartItems: MockCartItem[];
  isLoading: boolean;
  stockNotice: CartStockNoticeState | null;
  dismissStockNotice: () => void;
} = {
  cartItems: [],
  isLoading: true,
  stockNotice: null,
  dismissStockNotice: jest.fn(),
};
const mockTrackAnalyticsEvent = jest.fn();

jest.mock("@/contexts/CartContext", () => ({ useCart: () => mockCart }));
jest.mock("@/hooks/useCartShellReady", () => ({ useCartShellReady: () => true }));
jest.mock("@/utils/cartScrollIntent", () => ({ consumeCartScrollTop: () => false }));
jest.mock("@/services/product/homepage", () => ({
  getRandomProducts: jest.fn().mockResolvedValue([]),
}));
jest.mock("@/lib/analytics", () => ({
  trackAnalyticsEvent: (event: unknown) => mockTrackAnalyticsEvent(event),
}));
jest.mock("next/dynamic", () => () => () => null);
jest.mock("@/components/ShoppingCart/Table/Desktop", () => () => null);
jest.mock("@/components/ShoppingCart/Table/Mobile", () => () => null);
jest.mock("@/components/Skeletons/CartSkeleton", () => () => null);
jest.mock("@/components/ShoppingCart/Empty", () => () => null);
jest.mock("@/components/ShoppingCart/OrderSummaryCard", () => () => null);
jest.mock("@/components/PDP/Icons/HeartIcon", () => () => null);
jest.mock("@/components/layout/PageContainer", () => ({ children }: { children: React.ReactNode }) => (
  <div>{children}</div>
));

import CartPageClient from "./CartPageClient";

describe("CartPageClient view_cart", () => {
  beforeEach(() => {
    mockTrackAnalyticsEvent.mockClear();
    mockCart.cartItems = [];
    mockCart.isLoading = true;
  });

  it("fires once when the cart has loaded with items, not again on edits", () => {
    const view = render(<CartPageClient />);
    expect(mockTrackAnalyticsEvent).not.toHaveBeenCalled();

    mockCart.isLoading = false;
    mockCart.cartItems = [{ id: "a", price: 100_000, quantity: 2 }];
    view.rerender(<CartPageClient />);
    expect(mockTrackAnalyticsEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "view_cart",
        valueToman: 200_000,
        properties: { quantity: 2 },
      }),
    );

    mockCart.cartItems = [{ id: "a", price: 100_000, quantity: 3 }];
    view.rerender(<CartPageClient />);
    expect(mockTrackAnalyticsEvent).toHaveBeenCalledTimes(1);
  });

  it("does not fire for an empty cart", () => {
    mockCart.isLoading = false;
    render(<CartPageClient />);
    expect(mockTrackAnalyticsEvent).not.toHaveBeenCalled();
  });
});

describe("CartPageClient stock notice", () => {
  beforeEach(() => {
    mockCart.isLoading = false;
    mockCart.stockNotice = null;
  });

  // The login-time stock check can remove every line; the empty state alone
  // would make the shopper's items vanish without a word.
  it("names the removed line above the empty cart", () => {
    mockCart.cartItems = [];
    mockCart.stockNotice = { adjustedCartItemIds: [], removedNames: ["E2E Fixture Product S17"] };
    render(<CartPageClient />);
    expect(screen.getByTestId("cart-stock-notice")).toHaveTextContent("E2E Fixture Product S17");
  });

  it("shows above a cart whose lines were shortened", () => {
    mockCart.cartItems = [{ id: "a", price: 100_000, quantity: 1 }];
    mockCart.stockNotice = { adjustedCartItemIds: ["a"], removedNames: [] };
    render(<CartPageClient />);
    expect(screen.getByTestId("cart-stock-notice")).toBeInTheDocument();
  });

  it("renders nothing when the stock check changed nothing", () => {
    mockCart.cartItems = [{ id: "a", price: 100_000, quantity: 1 }];
    render(<CartPageClient />);
    expect(screen.queryByTestId("cart-stock-notice")).not.toBeInTheDocument();
  });
});
