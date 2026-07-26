import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CartProvider, useCart, type CartItem } from "../CartContext";

const mockToastCustom = jest.fn(() => "toast-id");
const mockToastDismiss = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: {
    custom: (...args: unknown[]) => mockToastCustom(...args),
    dismiss: (...args: unknown[]) => mockToastDismiss(...args),
  },
}));

jest.mock("@/services", () => ({
  CartService: {
    getUserCart: jest.fn().mockResolvedValue({ data: [] }),
    checkCartStock: jest.fn().mockResolvedValue({ valid: true }),
    addItemToCart: jest.fn().mockResolvedValue({}),
    removeCartItem: jest.fn().mockResolvedValue({}),
    updateCartItem: jest.fn().mockResolvedValue({}),
    clearCart: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock("@/utils/offlineQueue", () => ({
  queueAction: jest.fn(),
  removeQueuedAction: jest.fn(),
  setupOfflineQueueListener: jest.fn(() => jest.fn()),
  isOnline: jest.fn(() => true),
}));

jest.mock("@/utils/haptics", () => ({
  hapticSuccess: jest.fn(),
  hapticError: jest.fn(),
}));

jest.mock("@/lib/analytics/matomo", () => ({
  trackFunnelStep: jest.fn(),
  trackMatomoEvent: jest.fn(),
}));

const cartItem: CartItem = {
  id: "item-1",
  slug: "test-product",
  productId: "product-1",
  variationId: "variation-1",
  name: "محصول تست",
  category: "دسته تست",
  price: 1000,
  quantity: 1,
  image: "/uploads/test.jpg",
};

function CartProbe() {
  const { cartItems, removeFromCart } = useCart();

  return (
    <div>
      <span data-testid="cart-count">{cartItems.length}</span>
      <button type="button" onClick={() => removeFromCart(cartItem.id)}>
        remove
      </button>
    </div>
  );
}

function VariantCartProbe() {
  const { cartItems, addToCart } = useCart();
  const addVariant = (variationId: string) =>
    addToCart({
      ...cartItem,
      id: `product-1-${variationId}`,
      variationId,
      color: variationId,
    });

  return (
    <div>
      <span data-testid="variant-cart-count">{cartItems.length}</span>
      <span data-testid="variant-cart-lines">
        {cartItems.map((item) => `${item.variationId}:${item.quantity}`).join("|")}
      </span>
      <button type="button" onClick={() => addVariant("variation-1")}>add first</button>
      <button type="button" onClick={() => addVariant("variation-2")}>add second</button>
    </div>
  );
}

describe("CartProvider remove undo", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("cart", JSON.stringify([cartItem]));
  });

  it("shows an undo toast when removing an item and restores it when undo is clicked", async () => {
    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("cart-count")).toHaveTextContent("1"));

    fireEvent.click(screen.getByText("remove"));

    await waitFor(() => expect(screen.getByTestId("cart-count")).toHaveTextContent("0"));
    expect(mockToastCustom).toHaveBeenCalledTimes(1);

    const toastRenderer = mockToastCustom.mock.calls[0][0] as (toast: {
      id: string;
      visible: boolean;
    }) => React.ReactNode;

    render(<>{toastRenderer({ id: "toast-id", visible: true })}</>);

    expect(screen.getByText("کالا از سبد خرید حذف شد")).toBeInTheDocument();

    fireEvent.click(screen.getByText("برگرداندن"));

    expect(mockToastDismiss).toHaveBeenCalledWith("toast-id");
    await waitFor(() => expect(screen.getByTestId("cart-count")).toHaveTextContent("1"));
  });
});

describe("CartProvider variant identity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it("keeps different variants of the same product as separate guest-cart lines", async () => {
    render(
      <CartProvider>
        <VariantCartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("variant-cart-count")).toHaveTextContent("0"));
    fireEvent.click(screen.getByText("add first"));
    fireEvent.click(screen.getByText("add second"));

    await waitFor(() => expect(screen.getByTestId("variant-cart-count")).toHaveTextContent("2"));
    expect(screen.getByTestId("variant-cart-lines")).toHaveTextContent(
      "variation-1:1|variation-2:1",
    );
  });

  it("increments only the matching variant", async () => {
    render(
      <CartProvider>
        <VariantCartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("variant-cart-count")).toHaveTextContent("0"));
    fireEvent.click(screen.getByText("add first"));
    fireEvent.click(screen.getByText("add second"));
    fireEvent.click(screen.getByText("add first"));

    await waitFor(() => {
      expect(screen.getByTestId("variant-cart-lines")).toHaveTextContent(
        "variation-1:2|variation-2:1",
      );
    });
  });
});
