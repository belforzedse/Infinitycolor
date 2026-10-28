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
    mergeGuestCart: jest
      .fn()
      .mockResolvedValue({ accepted: [], adjusted: [], rejected: [], replayed: false }),
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
  readAuthStateVersion: jest.fn(() => 0),
  centralAuth: {
    tokenManager: {
      getToken: jest.fn(),
      getTokenOutcome: jest.fn(async (options: unknown) => {
        try {
          const token = await (
            jest.requireMock("@/lib/central-auth") as {
              centralAuth: {
                tokenManager: { getToken: (options: unknown) => Promise<string | null> };
              };
            }
          ).centralAuth.tokenManager.getToken(options);
          return token ? { state: "authenticated", token } : { state: "unauthenticated" };
        } catch (error) {
          return { state: "unavailable", reasonCode: "network" };
        }
      }),
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
  const { cartItems, removeFromCart, isCartReady, authRecoveryUnavailable, retryAuthRecovery } =
    useCart();

  return (
    <div>
      <span data-testid="cart-ready">{String(isCartReady)}</span>
      <span data-testid="auth-unavailable">{String(authRecoveryUnavailable)}</span>
      <button onClick={retryAuthRecovery}>retry auth</button>
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
      <button
        type="button"
        disabled={!item}
        onClick={() => item && updateQuantity(item.id, item.quantity - 1)}
      >
        decrease
      </button>
    </div>
  );
}

const apiCart = (name: string, suffix: number, availableStock?: number, count = 1) => ({
  cart_items: [
    {
      id: 100 + suffix,
      Count: count,
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

  /**
   * The stock snapshot can fall below what the line already holds — stock moved,
   * or a reservation (the shopper's own abandoned checkout included) lowered it.
   * The gate is for increases only; blocking the decrease too would leave the
   * shopper unable to shrink the quantity that is over the limit.
   */
  it("lets the shopper decrease a line that already exceeds the stock snapshot", async () => {
    mockCartService.getUserCart.mockReset().mockResolvedValue(apiCart("محصول تست", 1, 1, 3));

    render(
      <CartProvider>
        <QuantityProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("quantity")).toHaveTextContent("3"));
    expect(screen.getByTestId("available-stock")).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: "decrease" }));

    await waitFor(() => expect(mockCartService.updateCartItem).toHaveBeenCalledWith(101, 2));
    expect(mockNotify.error).not.toHaveBeenCalled();
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

  it("does not initialize or overwrite a guest cart during temporary auth failure", async () => {
    const stored = JSON.stringify([cartItem]);
    localStorage.setItem("cart", stored);
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockRejectedValueOnce(
      new Error("temporary network failure"),
    );
    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("auth-unavailable")).toHaveTextContent("true"));
    expect(screen.getByTestId("cart-ready")).toHaveTextContent("false");
    expect(localStorage.getItem("cart")).toBe(stored);
    expect(mockCartService.getUserCart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "retry auth" }));
    await waitFor(() => expect(screen.getByTestId("cart-ready")).toHaveTextContent("true"));
    expect(screen.getByTestId("cart-count")).toHaveTextContent("1");
  });

  describe("automatic session recovery", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("recovers from a failed initial check and restores the guest cart", async () => {
      const stored = JSON.stringify([cartItem]);
      localStorage.setItem("cart", stored);
      mockedCentralAuth.centralAuth.tokenManager.getToken.mockRejectedValueOnce(
        new Error("network"),
      );
      render(
        <CartProvider>
          <CartProbe />
        </CartProvider>,
      );
      await act(async () => {});
      expect(screen.getByTestId("cart-ready")).toHaveTextContent("false");
      expect(localStorage.getItem("cart")).toBe(stored);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.getByTestId("cart-ready")).toHaveTextContent("true");
      expect(screen.getByTestId("auth-unavailable")).toHaveTextContent("false");
      expect(screen.getByTestId("cart-count")).toHaveTextContent("1");
      expect(mockCartService.getUserCart).not.toHaveBeenCalled();
    });

    it("bounds retries, preserves an unknown identity, and recovers when connectivity returns", async () => {
      const stored = JSON.stringify([cartItem]);
      localStorage.setItem("cart", stored);
      const getToken = mockedCentralAuth.centralAuth.tokenManager.getToken;
      getToken.mockRejectedValue(new Error("network"));
      render(
        <CartProvider>
          <CartProbe />
        </CartProvider>,
      );
      await act(async () => {});
      for (const delay of [1_000, 3_000, 8_000, 60_000]) {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(delay);
        });
      }
      expect(getToken).toHaveBeenCalledTimes(4);
      expect(screen.getByTestId("cart-ready")).toHaveTextContent("false");
      expect(localStorage.getItem("cart")).toBe(stored);
      expect(mockCartService.getUserCart).not.toHaveBeenCalled();
      getToken.mockResolvedValue(null);
      await act(async () => {
        window.dispatchEvent(new Event("online"));
      });
      expect(screen.getByTestId("cart-ready")).toHaveTextContent("true");
      expect(screen.getByTestId("cart-count")).toHaveTextContent("1");
    });

    it("does not apply a recovery result after logout", async () => {
      let resolve!: (token: string) => void;
      const getToken = mockedCentralAuth.centralAuth.tokenManager.getToken;
      getToken.mockRejectedValueOnce(new Error("network")).mockImplementationOnce(
        () =>
          new Promise<string>((r) => {
            resolve = r;
          }),
      );
      render(
        <CartProvider>
          <CartProbe />
        </CartProvider>,
      );
      await act(async () => {});
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000);
      });
      act(() => mockAuthStateListener?.({ type: "logout", at: Date.now() }));
      await act(async () => resolve("old-account"));
      expect(screen.getByTestId("cart-ready")).toHaveTextContent("true");
      expect(screen.getByTestId("auth-unavailable")).toHaveTextContent("false");
      expect(mockCartService.getUserCart).not.toHaveBeenCalled();
    });

    it("cleans up retry timers and recovery listeners on unmount", async () => {
      const getToken = mockedCentralAuth.centralAuth.tokenManager.getToken;
      getToken.mockRejectedValue(new Error("network"));
      const { unmount } = render(
        <CartProvider>
          <CartProbe />
        </CartProvider>,
      );
      await act(async () => {});
      unmount();
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        window.dispatchEvent(new Event("focus"));
        await jest.advanceTimersByTimeAsync(60_000);
      });
      expect(getToken).toHaveBeenCalledTimes(1);
    });
  });

  it("discards a token result arriving after explicit logout", async () => {
    let resolve!: (value: string) => void;
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockImplementationOnce(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );
    act(() => mockAuthStateListener?.({ type: "logout", at: Date.now() }));
    await act(async () => resolve("old-account"));
    await waitFor(() => expect(screen.getByTestId("cart-ready")).toHaveTextContent("true"));
    expect(mockCartService.getUserCart).not.toHaveBeenCalled();
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

  it("keeps the valid guest lines when one stored line is malformed", async () => {
    // JSON.stringify turns a NaN price into null, so a single variation with an
    // unparsable Price used to wipe the whole cart on the next read.
    localStorage.setItem(
      "cart",
      JSON.stringify([cartItem, { ...cartItem, id: "item-2", price: null }]),
    );

    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("cart-count")).toHaveTextContent("1"));
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("cart") || "[]");
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe("item-1");
    });
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
    mockCartService.mergeGuestCart.mockResolvedValue({
      accepted: [{ productVariationId: 42, quantity: 1, appliedQuantity: 1 }],
      adjusted: [],
      rejected: [],
      replayed: false,
    });
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

  it("names the reason when every guest line was unavailable instead of calling it a sync", async () => {
    // An all-rejected merge leaves the account cart empty. Reporting that as
    // "synced with current stock" is what makes an empty cart look like a bug.
    localStorage.setItem("cart", JSON.stringify([{ ...cartItem, variationId: "42" }]));
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue("account-a");
    mockCartService.mergeGuestCart.mockResolvedValue({
      accepted: [],
      adjusted: [],
      rejected: [{ productVariationId: 42, quantity: 1, reason: "INSUFFICIENT_STOCK" }],
      replayed: false,
    });

    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(mockNotify.error).toHaveBeenCalled());
    expect(mockNotify.error.mock.calls[0][0]).toContain("موجود نبود");
    expect(mockNotify.success).not.toHaveBeenCalled();
  });

  it("announces an all-rejected result even when the server replays it", async () => {
    // A replay only arrives after a lost response told the shopper their items
    // were preserved. Clearing the guest cart silently here would contradict
    // that message and leave exactly the empty cart this path is meant to explain.
    localStorage.setItem("cart", JSON.stringify([{ ...cartItem, variationId: "42" }]));
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue("account-a");
    mockCartService.mergeGuestCart.mockResolvedValue({
      accepted: [],
      adjusted: [],
      rejected: [{ productVariationId: 42, quantity: 1, reason: "INSUFFICIENT_STOCK" }],
      replayed: true,
    });

    render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(mockNotify.error).toHaveBeenCalled());
    expect(mockNotify.error.mock.calls[0][0]).toContain("موجود نبود");
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

const mockAnalytics = jest.requireMock("@/lib/analytics") as {
  trackFunnelStep: jest.Mock;
  trackAnalyticsEvent: jest.Mock;
};

function analyticsActions(): string[] {
  return mockAnalytics.trackAnalyticsEvent.mock.calls.map(([event]) => event.action);
}

function SignedInCartProbe() {
  const { cartItems, addToCart, removeFromCart, updateQuantity } = useCart();
  const item = cartItems[0];
  return (
    <div>
      <span data-testid="signed-in-count">{cartItems.length}</span>
      <button type="button" disabled={!item} onClick={() => item && removeFromCart(item.id)}>
        remove first
      </button>
      <button
        type="button"
        disabled={!item}
        onClick={() => item && updateQuantity(item.id, item.quantity + 1)}
      >
        increase first
      </button>
      <button type="button" onClick={() => addToCart({ ...cartItem, variationId: "209" })}>
        add
      </button>
    </div>
  );
}

describe("CartProvider analytics outcomes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue("account-a");
    mockedCentralAuth.subscribeToAuthState.mockReset().mockImplementation(() => jest.fn());
    mockIsOnline.mockReturnValue(true);
    mockCartService.getUserCart.mockResolvedValue(apiCart("محصول تست", 1, 5));
    mockCartService.checkCartStock.mockResolvedValue({ valid: true });
    mockCartService.updateCartItem.mockResolvedValue({});
    mockCartService.removeCartItem.mockResolvedValue({});
    mockCartService.addItemToCart.mockResolvedValue({});
    localStorage.clear();
  });

  async function renderSignedIn() {
    render(
      <CartProvider>
        <SignedInCartProbe />
      </CartProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("signed-in-count")).toHaveTextContent("1"));
  }

  it("records update_quantity only after the server accepts it", async () => {
    await renderSignedIn();
    fireEvent.click(screen.getByRole("button", { name: "increase first" }));

    await waitFor(() => expect(analyticsActions()).toContain("update_quantity"));
    expect(mockCartService.updateCartItem).toHaveBeenCalledWith(101, 2);
    expect(mockAnalytics.trackAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update_quantity",
        properties: expect.objectContaining({ quantity: 2 }),
      }),
    );
  });

  it("records no update_quantity when the server rejects it", async () => {
    mockCartService.updateCartItem.mockRejectedValueOnce(new Error("boom"));
    await renderSignedIn();
    fireEvent.click(screen.getByRole("button", { name: "increase first" }));

    await waitFor(() => expect(mockNotify.error).toHaveBeenCalled());
    expect(analyticsActions()).not.toContain("update_quantity");
  });

  it("records remove_from_cart only after the server accepts it", async () => {
    await renderSignedIn();
    mockCartService.getUserCart.mockResolvedValue({ cart_items: [] });
    fireEvent.click(screen.getByRole("button", { name: "remove first" }));

    await waitFor(() => expect(analyticsActions()).toEqual(["remove_from_cart"]));
    expect(mockCartService.removeCartItem).toHaveBeenCalledWith(101);
  });

  it("records no remove_from_cart when the server rejects it", async () => {
    mockCartService.removeCartItem.mockRejectedValueOnce(new Error("boom"));
    await renderSignedIn();
    fireEvent.click(screen.getByRole("button", { name: "remove first" }));

    await waitFor(() =>
      expect(mockNotify.error).toHaveBeenCalledWith("حذف کالا از سبد خرید با خطا مواجه شد"),
    );
    expect(analyticsActions()).not.toContain("remove_from_cart");
  });

  it("says why an add was refused and resyncs the cart", async () => {
    await renderSignedIn();
    mockCartService.getUserCart.mockClear();
    // The shape ApiClient rejects with for ctx.badRequest("Product is currently unavailable").
    mockCartService.addItemToCart.mockRejectedValueOnce({
      message: "Product is currently unavailable",
      status: 400,
    });
    fireEvent.click(screen.getByRole("button", { name: "add" }));

    await waitFor(() =>
      expect(mockNotify.error).toHaveBeenCalledWith("این محصول در حال حاضر قابل خرید نیست."),
    );
    expect(mockCartService.getUserCart).toHaveBeenCalled();
  });

  it("records add_to_cart once on success and never on failure", async () => {
    await renderSignedIn();
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    await waitFor(() => expect(mockAnalytics.trackFunnelStep).toHaveBeenCalledTimes(1));
    expect(mockAnalytics.trackFunnelStep).toHaveBeenCalledWith("add_to_cart", expect.anything());

    mockAnalytics.trackFunnelStep.mockClear();
    mockCartService.addItemToCart.mockRejectedValueOnce(new Error("out of stock"));
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    await waitFor(() => expect(mockCartService.addItemToCart).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockAnalytics.trackFunnelStep).not.toHaveBeenCalled();
  });
});

describe("CartProvider login-time stock correction", () => {
  function NoticeProbe() {
    const { stockNotice, cartItems, isLoading } = useCart();
    return (
      <div>
        <span data-testid="loading">{String(isLoading)}</span>
        <span data-testid="count">{cartItems.length}</span>
        <span data-testid="notice">
          {stockNotice ? stockNotice.removedNames.join("|") : "none"}
        </span>
      </div>
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue("account-a");
    mockedCentralAuth.subscribeToAuthState.mockReset().mockImplementation(() => jest.fn());
    mockIsOnline.mockReturnValue(true);
    localStorage.clear();
  });

  it("names a line the stock check removed when the cart loads", async () => {
    mockCartService.checkCartStock.mockResolvedValue({
      success: true,
      valid: false,
      cartIsEmpty: true,
      itemsRemoved: [
        {
          cartItemId: 7,
          productVariationId: 9,
          productTitle: "E2E Fixture Product S17",
          reason: "inactive",
        },
      ],
    });
    mockCartService.getUserCart.mockResolvedValue({ id: 1, cart_items: [] });

    render(
      <CartProvider>
        <NoticeProbe />
      </CartProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    await waitFor(() => expect(mockCartService.getUserCart).toHaveBeenCalled());
    expect(screen.getByTestId("notice")).toHaveTextContent("E2E Fixture Product S17");
  });
});
