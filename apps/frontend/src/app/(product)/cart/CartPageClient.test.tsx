import React from "react";
import { render } from "@testing-library/react";

type MockCartItem = { id: string; price: number; quantity: number };
const mockCart: { cartItems: MockCartItem[]; isLoading: boolean } = {
  cartItems: [],
  isLoading: true,
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
