import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    mergeGuestCart: jest.fn().mockResolvedValue({ adjusted: [], rejected: [] }),
  },
}));

jest.mock("@/utils/offlineQueue", () => ({
  queueAction: jest.fn(),
  removeQueuedAction: jest.fn(),
  setupOfflineQueueListener: jest.fn(() => jest.fn()),
  isOnline: jest.fn(() => true),
}));

jest.mock("@/utils/notify", () => ({
  __esModule: true,
  notify: { success: jest.fn(), error: jest.fn() },
  default: { success: jest.fn(), error: jest.fn() },
}));

jest.mock("@/utils/haptics", () => ({
  hapticSuccess: jest.fn(),
  hapticError: jest.fn(),
}));

jest.mock("@/lib/analytics", () => ({
  trackFunnelStep: jest.fn(),
  trackAnalyticsEvent: jest.fn(),
}));

jest.mock("@/lib/central-auth", () => ({
  centralAuth: {
    tokenManager: {
      getToken: jest.fn(),
    },
  },
  subscribeToAuthState: jest.fn(),
}));

const mockedCentralAuth = jest.requireMock("@/lib/central-auth") as {
  centralAuth: { tokenManager: { getToken: jest.Mock } };
  subscribeToAuthState: jest.Mock;
};
let mockAuthStateListener:
  | ((event: { type: "logout" | "session-changed"; at: number }) => void)
  | undefined;

const mockCartService = jest.requireMock("@/services").CartService as {
  getUserCart: jest.Mock;
  checkCartStock: jest.Mock;
  addItemToCart: jest.Mock;
  removeCartItem: jest.Mock;
  updateCartItem: jest.Mock;
  clearCart: jest.Mock;
  mergeGuestCart: jest.Mock;
};
const mockIsOnline = jest.requireMock("@/utils/offlineQueue").isOnline as jest.Mock;
const mockNotify = jest.requireMock("@/utils/notify").default as {
  success: jest.Mock;
  error: jest.Mock;
};

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

function QuantityProbe() {
  const { cartItems, updateQuantity } = useCart();
  const item = cartItems[0];

  return (
    <div>
      <span data-testid="quantity">{item?.quantity ?? 0}</span>
      <span data-testid="available-stock">{item?.availableStock ?? "unknown"}</span>
      <button
        type="button"
        disabled={!item}
        onClick={() => item && updateQuantity(item.id, item.quantity + 1)}
      >
        increase
      </button>
    </div>
  );
}

const apiCart = (name: string, suffix: number, availableStock?: number) => ({
  cart_items: [
    {
      id: 100 + suffix,
      Count: 1,
      Sum: 1000,
      availableStock,
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

describe("CartProvider stock snapshots", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthStateListener = undefined;
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue("account-a");
    mockedCentralAuth.subscribeToAuthState.mockReset().mockImplementation((listener) => {
      mockAuthStateListener = listener;
      return jest.fn();
    });
    mockIsOnline.mockReturnValue(true);
    mockCartService.getUserCart.mockResolvedValue(apiCart("محصول تست", 1, 1));
    mockCartService.checkCartStock.mockResolvedValue({ valid: true });
    mockCartService.updateCartItem.mockResolvedValue({});
    localStorage.clear();
  });

  it("blocks an increase at the server-provided limit with a specific message", async () => {
    render(
      <CartProvider>
        <QuantityProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("available-stock")).toHaveTextContent("1"));
    fireEvent.click(screen.getByRole("button", { name: "increase" }));

    expect(mockCartService.updateCartItem).not.toHaveBeenCalled();
    expect(mockNotify.error).toHaveBeenCalledWith("موجودی بیشتری از این کالا در دسترس نیست.");
    expect(screen.getByTestId("quantity")).toHaveTextContent("1");
  });

  it("refreshes a stale snapshot and keeps the stock-specific message", async () => {
    mockCartService.getUserCart
      .mockReset()
      .mockResolvedValueOnce(apiCart("محصول تست", 1, 2))
      .mockResolvedValue(apiCart("محصول تست", 1, 1));
    mockCartService.updateCartItem.mockRejectedValueOnce({
      message: "Insufficient stock",
      errorCode: "CART_STOCK_EXCEEDED",
    });

    render(
      <CartProvider>
        <QuantityProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("available-stock")).toHaveTextContent("2"));
    fireEvent.click(screen.getByRole("button", { name: "increase" }));

    await waitFor(() =>
      expect(mockNotify.error).toHaveBeenCalledWith("موجودی بیشتری از این کالا در دسترس نیست."),
    );
    expect(mockCartService.updateCartItem).toHaveBeenCalledWith(101, 2);
    await waitFor(() => expect(screen.getByTestId("available-stock")).toHaveTextContent("1"));
    expect(screen.getByTestId("quantity")).toHaveTextContent("1");
  });
});

function VariantCartProbe() {
  const { cartItems, addToCart, isCartReady } = useCart();
  const addVariant = (variationId: string) =>
    addToCart({
      ...cartItem,
      id: `product-1-${variationId}`,
      variationId,
      color: variationId,
    });

  return (
    <div>
      <span data-testid="variant-cart-ready">{String(isCartReady)}</span>
      <span data-testid="variant-cart-count">{cartItems.length}</span>
      <span data-testid="variant-cart-lines">
        {cartItems.map((item) => `${item.variationId}:${item.quantity}`).join("|")}
      </span>
      <button type="button" onClick={() => addVariant("variation-1")}>
        add first
      </button>
      <button type="button" onClick={() => addVariant("variation-2")}>
        add second
      </button>
    </div>
  );
}

describe("CartProvider remove undo", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthStateListener = undefined;
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue(null);
    mockedCentralAuth.subscribeToAuthState.mockReset().mockImplementation((listener) => {
      mockAuthStateListener = listener;
      return jest.fn();
    });
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
    mockAuthStateListener = undefined;
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue(null);
    mockedCentralAuth.subscribeToAuthState.mockReset().mockImplementation((listener) => {
      mockAuthStateListener = listener;
      return jest.fn();
    });
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

    await waitFor(() => expect(screen.getByTestId("variant-cart-ready")).toHaveTextContent("true"));
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

    await waitFor(() => expect(screen.getByTestId("variant-cart-ready")).toHaveTextContent("true"));
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
    mockAuthStateListener = undefined;
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue(null);
    mockedCentralAuth.subscribeToAuthState.mockReset().mockImplementation((listener) => {
      mockAuthStateListener = listener;
      return jest.fn();
    });
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
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue("account-a");
    mockCartService.getUserCart.mockResolvedValue(apiCart("سبد حساب الف", 1));

    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("cart-names")).toHaveTextContent("سبد حساب الف"));
    expect(localStorage.getItem("cart")).toBeNull();

    act(() => mockAuthStateListener?.({ type: "logout", at: Date.now() }));

    await waitFor(() => expect(screen.getByTestId("cart-count")).toHaveTextContent("0"));
    expect(localStorage.getItem("cart")).toBe("[]");
    expect(localStorage.getItem("cart")).not.toContain("سبد حساب الف");
  });

  it("drops the prior account cart immediately when the session identity changes", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken
      .mockResolvedValueOnce("account-a")
      .mockResolvedValue("account-b");
    mockCartService.getUserCart
      .mockResolvedValueOnce(apiCart("سبد حساب الف", 1))
      .mockResolvedValueOnce(apiCart("سبد حساب ب", 2));

    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("cart-names")).toHaveTextContent("سبد حساب الف"));

    act(() => mockAuthStateListener?.({ type: "session-changed", at: Date.now() }));

    await waitFor(() => expect(screen.getByTestId("cart-names")).toHaveTextContent("سبد حساب ب"));
    expect(screen.getByTestId("cart-names")).not.toHaveTextContent("سبد حساب الف");
    expect(localStorage.getItem("cart")).toBeNull();
  });
});

describe("CartProvider guest cart handover", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthStateListener = undefined;
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue(null);
    mockedCentralAuth.subscribeToAuthState.mockReset().mockImplementation((listener) => {
      mockAuthStateListener = listener;
      return jest.fn();
    });
    mockIsOnline.mockReturnValue(true);
    mockCartService.getUserCart.mockResolvedValue({ cart_items: [] });
    mockCartService.checkCartStock.mockResolvedValue({ valid: true });
    mockCartService.mergeGuestCart.mockResolvedValue({ adjusted: [], rejected: [] });
    localStorage.clear();
  });

  it("merges a stored guest cart when the provider initializes for a signed-in shopper", async () => {
    // The live central-auth handoff never passes through the legacy login pages that
    // used to trigger this, so the merge has to happen where the provider resolves.
    localStorage.setItem("cart", JSON.stringify([{ ...cartItem, variationId: "42" }]));
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue("account-a");

    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(mockCartService.mergeGuestCart).toHaveBeenCalledTimes(1));
    const [, mergeItems] = mockCartService.mergeGuestCart.mock.calls[0];
    expect(mergeItems).toEqual([{ productVariationId: 42, quantity: 1 }]);
    await waitFor(() => expect(localStorage.getItem("cart")).toBeNull());
  });

  it("does not call the merge endpoint when there is no guest cart", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue("account-a");

    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("cart-count")).toHaveTextContent("0"));
    expect(mockCartService.mergeGuestCart).not.toHaveBeenCalled();
  });

  it("leaves the guest cart in place for a signed-out shopper", async () => {
    localStorage.setItem("cart", JSON.stringify([cartItem]));

    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("cart-count")).toHaveTextContent("1"));
    expect(mockCartService.mergeGuestCart).not.toHaveBeenCalled();
  });
});
