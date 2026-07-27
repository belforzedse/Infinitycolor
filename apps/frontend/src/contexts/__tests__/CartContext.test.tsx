import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CartProvider, useCart, type CartItem } from "../CartContext";
import { ACCESS_TOKEN_EVENT, ACCESS_TOKEN_STORAGE_KEY } from "@/utils/accessToken";

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

const mockCartService = jest.requireMock("@/services").CartService as {
  getUserCart: jest.Mock;
  checkCartStock: jest.Mock;
  addItemToCart: jest.Mock;
  removeCartItem: jest.Mock;
  updateCartItem: jest.Mock;
  clearCart: jest.Mock;
};
const mockIsOnline = jest.requireMock("@/utils/offlineQueue").isOnline as jest.Mock;

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
      <span data-testid="cart-names">{cartItems.map((item) => item.name).join("|")}</span>
      <button type="button" onClick={() => removeFromCart(cartItem.id)}>
        remove
      </button>
    </div>
  );
}

const apiCart = (name: string, suffix: number) => ({
  cart_items: [
    {
      id: 100 + suffix,
      Count: 1,
      Sum: 1000,
      product_variation: {
        id: 200 + suffix,
        Price: 1000,
        product: {
          id: 300 + suffix,
          Title: name,
          Slug: `product-${suffix}`,
          CoverImage: null,
          product_main_category: { Title: "دسته تست" },
        },
      },
    },
  ],
});

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
    mockIsOnline.mockReturnValue(true);
    mockCartService.getUserCart.mockResolvedValue({ cart_items: [] });
    mockCartService.checkCartStock.mockResolvedValue({ valid: true });
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
    mockIsOnline.mockReturnValue(true);
    mockCartService.getUserCart.mockResolvedValue({ cart_items: [] });
    mockCartService.checkCartStock.mockResolvedValue({ valid: true });
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

describe("CartProvider identity and storage hardening", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsOnline.mockReturnValue(true);
    mockCartService.getUserCart.mockResolvedValue({ cart_items: [] });
    mockCartService.checkCartStock.mockResolvedValue({ valid: true });
    localStorage.clear();
  });

  it("discards malformed guest cart storage without crashing", async () => {
    localStorage.setItem("cart", JSON.stringify({ item: cartItem }));

    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("cart-count")).toHaveTextContent("0"));
    await waitFor(() => expect(localStorage.getItem("cart")).toBe("[]"));
  });

  it("never persists an authenticated cart into the following guest session", async () => {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "account-a");
    mockCartService.getUserCart.mockResolvedValue(apiCart("سبد حساب الف", 1));

    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("cart-names")).toHaveTextContent("سبد حساب الف"));
    expect(localStorage.getItem("cart")).toBeNull();

    localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    act(() => window.dispatchEvent(new Event(ACCESS_TOKEN_EVENT)));

    await waitFor(() => expect(screen.getByTestId("cart-count")).toHaveTextContent("0"));
    expect(localStorage.getItem("cart")).toBe("[]");
    expect(localStorage.getItem("cart")).not.toContain("سبد حساب الف");
  });

  it("drops the prior account cart immediately when the token identity changes", async () => {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "account-a");
    mockCartService.getUserCart
      .mockResolvedValueOnce(apiCart("سبد حساب الف", 1))
      .mockResolvedValueOnce(apiCart("سبد حساب ب", 2));

    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("cart-names")).toHaveTextContent("سبد حساب الف"));

    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "account-b");
    act(() => window.dispatchEvent(new Event(ACCESS_TOKEN_EVENT)));

    await waitFor(() => expect(screen.getByTestId("cart-names")).toHaveTextContent("سبد حساب ب"));
    expect(screen.getByTestId("cart-names")).not.toHaveTextContent("سبد حساب الف");
    expect(localStorage.getItem("cart")).toBeNull();
  });
});
