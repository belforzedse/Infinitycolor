import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import CartDrawerItem from "../Drawer/Item";
import CartDrawer from "../Drawer";
import ShoppingCartQuantityControl from "../QuantityControl";
import type { CartItem } from "@/contexts/CartContext";
import { useCart } from "@/contexts/CartContext";

jest.mock("@/contexts/CartContext", () => ({
  useCart: jest.fn(),
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ alt }: { alt: string }) => React.createElement("img", { alt }),
}));

jest.mock("@/utils/imageLoader", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@use-gesture/react", () => ({
  useDrag: () => () => ({}),
}));

const useCartMock = useCart as jest.Mock;

const cartItem: CartItem = {
  id: "item-1",
  slug: "test-product",
  productId: "product-1",
  variationId: "variation-1",
  name: "محصول تست",
  category: "دسته تست",
  price: 1000,
  quantity: 2,
  image: "/uploads/test.jpg",
};

describe("cart mutation controls", () => {
  beforeEach(() => {
    useCartMock.mockReturnValue({
      updateQuantity: jest.fn(),
      removeFromCart: jest.fn(),
      isLoading: true,
    });
  });

  it("disables drawer quantity and remove controls while the cart is mutating", () => {
    render(<CartDrawerItem item={cartItem} />);

    expect(screen.getByRole("button", { name: "افزایش تعداد کالا" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "کاهش تعداد کالا" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "حذف کالا از سبد خرید" })).toBeDisabled();
  });

  it("disables shared cart quantity controls while the cart is mutating", () => {
    render(<ShoppingCartQuantityControl itemId={cartItem.id} quantity={cartItem.quantity} />);

    expect(screen.getByTestId("cart-quantity-increase")).toBeDisabled();
    expect(screen.getByTestId("cart-quantity-decrease")).toBeDisabled();
    expect(screen.getByTestId("cart-item-remove")).toBeDisabled();
  });

  it("keeps the drawer chrome fixed around one bounded scroll region", () => {
    const closeDrawer = jest.fn();
    useCartMock.mockReturnValue({
      cartItems: [cartItem],
      isDrawerOpen: true,
      isCartReady: true,
      isLoading: false,
      closeDrawer,
      totalItems: cartItem.quantity,
      totalPrice: cartItem.price * cartItem.quantity,
      updateQuantity: jest.fn(),
      removeFromCart: jest.fn(),
    });

    render(<CartDrawer />);

    expect(screen.getByTestId("cart-drawer")).toHaveClass("h-dvh", "min-h-0", "overflow-hidden");
    expect(screen.getByRole("heading", { name: "سبد خرید" }).closest("header")).toHaveClass(
      "sticky",
      "top-0",
      "shrink-0",
    );
    expect(screen.getByTestId("cart-drawer-scroll-region")).toHaveClass(
      "min-h-0",
      "overflow-y-auto",
      "overscroll-contain",
    );
    expect(screen.getByTestId("cart-drawer-checkout").closest("footer")).toHaveClass(
      "sticky",
      "bottom-0",
      "shrink-0",
    );
    expect(screen.getByTestId("cart-drawer-checkout")).toHaveAttribute("href", "/checkout");
    expect(screen.getByTestId("cart-drawer-view-cart")).toHaveAttribute("href", "/cart");

    fireEvent.click(screen.getByTestId("cart-drawer-checkout"));
    expect(closeDrawer).toHaveBeenCalled();
  });
});
