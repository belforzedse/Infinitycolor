import React from "react";
import { render, screen } from "@testing-library/react";
import CartDrawerItem from "../Drawer/Item";
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
});
