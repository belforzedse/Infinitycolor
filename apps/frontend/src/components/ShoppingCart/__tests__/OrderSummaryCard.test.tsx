import { render, screen } from "@testing-library/react";
import OrderSummaryCard from "../OrderSummaryCard";
import { useCart } from "@/contexts/CartContext";

jest.mock("@/contexts/CartContext", () => ({
  useCart: jest.fn(),
}));

const useCartMock = useCart as jest.Mock;

describe("OrderSummaryCard", () => {
  beforeEach(() => {
    useCartMock.mockReturnValue({
      subtotalBeforeDiscount: 2000,
      cartDiscountTotal: 200,
      totalPrice: 1800,
      totalItems: 2,
    });
  });

  it("exposes a native checkout href that stays above the mobile bottom nav", () => {
    render(<OrderSummaryCard />);

    const checkout = screen.getByTestId("cart-checkout-link");
    expect(checkout).toHaveAttribute("href", "/checkout");
    expect(checkout.tagName).toBe("A");
    expect(checkout).toHaveClass(
      "sticky",
      "z-[90]",
      "touch-manipulation",
      "min-h-12",
    );
  });
});
