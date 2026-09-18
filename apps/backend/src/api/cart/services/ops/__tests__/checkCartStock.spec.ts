import { checkCartStockOp } from "../checkCartStock";
import {
  findLiveCheckoutHoldForUser,
  resolveEligibleCheckoutHold,
} from "../../lib/checkout-hold";

jest.mock("../../lib/stock", () => {
  const actual = jest.requireActual("../../lib/stock");
  return {
    ...actual,
  };
});

jest.mock("../../lib/checkout-hold", () => {
  const actual = jest.requireActual("../../lib/checkout-hold");
  return {
    ...actual,
    resolveEligibleCheckoutHold: jest.fn().mockResolvedValue({ status: "missing" }),
    findLiveCheckoutHoldForUser: jest.fn().mockResolvedValue({ status: "none" }),
  };
});

const mockedResolveHold = resolveEligibleCheckoutHold as jest.MockedFunction<
  typeof resolveEligibleCheckoutHold
>;
const mockedFindLiveHold = findLiveCheckoutHoldForUser as jest.MockedFunction<
  typeof findLiveCheckoutHoldForUser
>;

function createStrapi(cart: any, updatedCart?: any) {
  const removeCartItem = jest.fn().mockResolvedValue({ success: true });
  const updateCartItem = jest.fn().mockResolvedValue({ success: true });
  const getUserCart = jest
    .fn()
    .mockResolvedValueOnce(cart)
    .mockResolvedValue(updatedCart ?? cart);

  const cartService = { getUserCart, removeCartItem, updateCartItem };
  const strapi = {
    service: jest.fn((uid: string) => {
      if (uid === "api::cart.cart") return cartService;
      throw new Error(`Unexpected service: ${uid}`);
    }),
  } as any;

  return { strapi, removeCartItem, updateCartItem, getUserCart };
}

describe("checkCartStockOp", () => {
  beforeEach(() => {
    mockedResolveHold.mockReset();
    mockedResolveHold.mockResolvedValue({ status: "missing" });
    mockedFindLiveHold.mockReset();
    mockedFindLiveHold.mockResolvedValue({ status: "none" });
  });
  it("keeps a starting empty cart valid", async () => {
    const empty = { cart_items: [] };
    const { strapi } = createStrapi(empty);

    const result = await checkCartStockOp(strapi, 1);

    expect(result).toMatchObject({
      success: true,
      valid: true,
      message: "Cart is empty",
    });
  });

  it("removes a last unit that is fully reserved and reports invalid", async () => {
    const cart = {
      cart_items: [
        {
          id: 10,
          Count: 1,
          product_variation: {
            id: 100,
            IsPublished: true,
            product: { id: 1, Title: "رنگ قرمز", Status: "Active" },
            product_stock: { Count: 1, reservedCount: 1 },
          },
        },
      ],
    };
    const { strapi, removeCartItem } = createStrapi(cart, { cart_items: [] });

    const result = await checkCartStockOp(strapi, 1);

    expect(removeCartItem).toHaveBeenCalledWith(10, 1);
    expect(result.valid).toBe(false);
    expect(result.cartIsEmpty).toBe(true);
    expect(result.itemsRemoved).toEqual([
      expect.objectContaining({
        cartItemId: 10,
        productTitle: "رنگ قرمز",
        available: 0,
      }),
    ]);
  });

  it("removes only the reserved line from a mixed cart", async () => {
    const cart = {
      cart_items: [
        {
          id: 10,
          Count: 1,
          product_variation: {
            id: 100,
            IsPublished: true,
            product: { id: 1, Title: "Held SKU", Status: "Active" },
            product_stock: { count: 1, reserved_count: 1 },
          },
        },
        {
          id: 20,
          Count: 2,
          product_variation: {
            id: 200,
            IsPublished: true,
            product: { id: 2, Title: "In stock SKU", Status: "Active" },
            product_stock: { Count: 5, reservedCount: 0 },
          },
        },
      ],
    };
    const remaining = {
      cart_items: [cart.cart_items[1]],
    };
    const { strapi, removeCartItem, updateCartItem } = createStrapi(cart, remaining);

    const result = await checkCartStockOp(strapi, 1);

    expect(removeCartItem).toHaveBeenCalledWith(10, 1);
    expect(removeCartItem).toHaveBeenCalledTimes(1);
    expect(updateCartItem).not.toHaveBeenCalled();
    expect(result.valid).toBe(false);
    expect(result.cartIsEmpty).toBe(false);
    expect(result.itemsRemoved?.[0].cartItemId).toBe(10);
  });

  it("adjusts quantity when reserved stock leaves fewer units than requested", async () => {
    const cart = {
      cart_items: [
        {
          id: 30,
          Count: 5,
          product_variation: {
            id: 300,
            IsPublished: true,
            product: { id: 3, Title: "Partial", Status: "Active" },
            product_stock: { Count: 5, reservedCount: 3 },
          },
        },
      ],
    };
    const { strapi, updateCartItem } = createStrapi(cart, {
      cart_items: [{ ...cart.cart_items[0], Count: 2 }],
    });

    const result = await checkCartStockOp(strapi, 1);

    expect(updateCartItem).toHaveBeenCalledWith(30, 2, 1);
    expect(result.valid).toBe(false);
    expect(result.itemsAdjusted).toEqual([
      expect.objectContaining({
        cartItemId: 30,
        requested: 5,
        available: 2,
        newQuantity: 2,
      }),
    ]);
  });

  it("stays invalid when a reserved line cannot be removed", async () => {
    const cart = {
      cart_items: [
        {
          id: 10,
          Count: 1,
          product_variation: {
            id: 100,
            IsPublished: true,
            product: { id: 1, Title: "رنگ قرمز", Status: "Active" },
            product_stock: { Count: 1, reservedCount: 1 },
          },
        },
      ],
    };
    const { strapi, removeCartItem } = createStrapi(cart, cart);
    removeCartItem.mockResolvedValue({
      success: false,
      message: "Cart owner is required",
    });

    const result = await checkCartStockOp(strapi, 1);

    expect(removeCartItem).toHaveBeenCalledWith(10, 1);
    expect(result.valid).toBe(false);
    expect(result.itemsRemoved).toBeUndefined();
    expect(result.cartIsEmpty).toBe(false);
  });

  it("refuses to run without a cart owner", async () => {
    const { strapi, removeCartItem, updateCartItem } = createStrapi({
      cart_items: [{ id: 10, Count: 1 }],
    });

    const result = await checkCartStockOp(strapi, undefined as unknown as number);

    expect(result).toEqual({
      success: false,
      valid: false,
      message: "Cart owner is required",
    });
    expect(removeCartItem).not.toHaveBeenCalled();
    expect(updateCartItem).not.toHaveBeenCalled();
  });

  it("keeps a last reserved unit when the identified checkout still holds it", async () => {
    const cart = {
      cart_items: [
        {
          id: 10,
          Count: 1,
          product_variation: {
            id: 100,
            IsPublished: true,
            product: { id: 1, Title: "رنگ قرمز", Status: "Active" },
            product_stock: { id: 700, Count: 1, reservedCount: 1 },
          },
        },
      ],
    };
    mockedResolveHold.mockResolvedValue({
      status: "held",
      hold: {
        attemptId: "attempt-1",
        orderId: 91,
        quoteHash: "sha256:original",
        gateway: "mellat",
        reservedUntil: new Date("2026-09-18T12:00:00.000Z"),
        quantitiesByStockId: new Map([[700, 1]]),
      },
    });
    const { strapi, removeCartItem, updateCartItem } = createStrapi(cart);

    const result = await checkCartStockOp(strapi, 1, { attemptId: "attempt-1" });

    expect(mockedFindLiveHold).not.toHaveBeenCalled();
    expect(removeCartItem).not.toHaveBeenCalled();
    expect(updateCartItem).not.toHaveBeenCalled();
    expect(result.valid).toBe(true);
    expect(result.reservationOutcome).toBe("held");
    expect(result.heldOrderId).toBe(91);
    expect(result.resumableCheckout).toEqual({
      attemptId: "attempt-1",
      orderId: 91,
      quoteHash: "sha256:original",
      gateway: "mellat",
      reservedUntil: "2026-09-18T12:00:00.000Z",
    });
  });

  it("does not reduce an original quantity of 2 when that order still holds 2 of 3", async () => {
    const cart = {
      cart_items: [
        {
          id: 30,
          Count: 2,
          product_variation: {
            id: 300,
            IsPublished: true,
            product: { id: 3, Title: "Partial", Status: "Active" },
            product_stock: { id: 800, Count: 3, reservedCount: 2 },
          },
        },
      ],
    };
    mockedResolveHold.mockResolvedValue({
      status: "held",
      hold: {
        attemptId: "attempt-2",
        orderId: 92,
        quantitiesByStockId: new Map([[800, 2]]),
      },
    });
    const { strapi, updateCartItem } = createStrapi(cart);

    const result = await checkCartStockOp(strapi, 1, { attemptId: "attempt-2" });

    expect(updateCartItem).not.toHaveBeenCalled();
    expect(result.valid).toBe(true);
  });

  it("credits the user's live hold when no attempt id is supplied", async () => {
    const cart = {
      cart_items: [
        {
          id: 10,
          Count: 1,
          product_variation: {
            id: 100,
            IsPublished: true,
            product: { id: 1, Title: "رنگ قرمز", Status: "Active" },
            product_stock: { id: 700, Count: 1, reservedCount: 1 },
          },
        },
      ],
    };
    mockedFindLiveHold.mockResolvedValue({
      status: "held",
      hold: {
        attemptId: "attempt-live",
        orderId: 91,
        quoteHash: "sha256:original",
        gateway: "mellat",
        reservedUntil: new Date("2026-09-18T12:00:00.000Z"),
        quantitiesByStockId: new Map([[700, 1]]),
      },
    });
    const { strapi, removeCartItem, updateCartItem } = createStrapi(cart);

    const result = await checkCartStockOp(strapi, 1);

    expect(removeCartItem).not.toHaveBeenCalled();
    expect(updateCartItem).not.toHaveBeenCalled();
    expect(result.valid).toBe(true);
    expect(result.reservationOutcome).toBe("held");
    expect(result.heldOrderId).toBe(91);
    expect(result.resumableCheckout).toEqual({
      attemptId: "attempt-live",
      orderId: 91,
      quoteHash: "sha256:original",
      gateway: "mellat",
      reservedUntil: "2026-09-18T12:00:00.000Z",
    });
  });

  it("credits the live hold when the named attempt is missing", async () => {
    const cart = {
      cart_items: [
        {
          id: 10,
          Count: 1,
          product_variation: {
            id: 100,
            IsPublished: true,
            product: { id: 1, Title: "رنگ قرمز", Status: "Active" },
            product_stock: { id: 700, Count: 1, reservedCount: 1 },
          },
        },
      ],
    };
    mockedResolveHold.mockResolvedValue({ status: "missing" });
    mockedFindLiveHold.mockResolvedValue({
      status: "held",
      hold: {
        attemptId: "attempt-live",
        orderId: 91,
        quoteHash: "sha256:original",
        quantitiesByStockId: new Map([[700, 1]]),
      },
    });
    const { strapi, removeCartItem } = createStrapi(cart);

    const result = await checkCartStockOp(strapi, 1, { attemptId: "other-attempt" });

    expect(removeCartItem).not.toHaveBeenCalled();
    expect(result.valid).toBe(true);
    expect(result.reservationOutcome).toBe("held");
    expect(result.resumableCheckout?.attemptId).toBe("attempt-live");
  });

  it("does not credit another checkout's reservation even for the same customer", async () => {
    const cart = {
      cart_items: [
        {
          id: 10,
          Count: 1,
          product_variation: {
            id: 100,
            IsPublished: true,
            product: { id: 1, Title: "رنگ قرمز", Status: "Active" },
            product_stock: { id: 700, Count: 1, reservedCount: 1 },
          },
        },
      ],
    };
    mockedResolveHold.mockResolvedValue({ status: "missing" });
    mockedFindLiveHold.mockResolvedValue({ status: "none" });
    const { strapi, removeCartItem } = createStrapi(cart, { cart_items: [] });

    const result = await checkCartStockOp(strapi, 1, { attemptId: "other-attempt" });

    expect(removeCartItem).toHaveBeenCalledWith(10, 1);
    expect(result.valid).toBe(false);
  });

  it("does not resurrect an expired hold as available stock", async () => {
    const cart = {
      cart_items: [
        {
          id: 10,
          Count: 1,
          product_variation: {
            id: 100,
            IsPublished: true,
            product: { id: 1, Title: "رنگ قرمز", Status: "Active" },
            product_stock: { id: 700, Count: 1, reservedCount: 1 },
          },
        },
      ],
    };
    mockedResolveHold.mockResolvedValue({ status: "expired" });
    const { strapi, removeCartItem } = createStrapi(cart, { cart_items: [] });

    const result = await checkCartStockOp(strapi, 1, { attemptId: "attempt-1" });

    expect(removeCartItem).toHaveBeenCalledWith(10, 1);
    expect(result.valid).toBe(false);
    expect(result.reservationOutcome).toBe("expired");
    expect(result.resumableCheckout).toBeNull();
  });

  it("does not treat a live-hold lookup error as missing stock", async () => {
    const cart = {
      cart_items: [
        {
          id: 10,
          Count: 1,
          product_variation: {
            id: 100,
            IsPublished: true,
            product: { id: 1, Title: "رنگ قرمز", Status: "Active" },
            product_stock: { id: 61157, Count: 1, reservedCount: 1 },
          },
        },
      ],
    };
    mockedFindLiveHold.mockResolvedValue({ status: "unavailable" });
    const { strapi, removeCartItem, updateCartItem } = createStrapi(cart);

    const result = await checkCartStockOp(strapi, 1);

    expect(removeCartItem).not.toHaveBeenCalled();
    expect(updateCartItem).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      valid: false,
      errorCode: "RESERVATION_LOOKUP_FAILED",
      reservationOutcome: "unavailable",
    });
  });

  it("does not treat a reservation lookup error as missing stock on an identified checkout", async () => {
    const cart = {
      cart_items: [
        {
          id: 10,
          Count: 1,
          product_variation: {
            id: 100,
            IsPublished: true,
            product: { id: 1, Title: "رنگ قرمز", Status: "Active" },
            product_stock: { id: 61157, Count: 1, reservedCount: 1 },
          },
        },
      ],
    };
    mockedResolveHold.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const { strapi, removeCartItem, updateCartItem } = createStrapi(cart);

    const result = await checkCartStockOp(strapi, 1, { attemptId: "c7d9313b-owner" });

    expect(removeCartItem).not.toHaveBeenCalled();
    expect(updateCartItem).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      valid: false,
      errorCode: "RESERVATION_LOOKUP_FAILED",
      reservationOutcome: "unavailable",
    });
    expect(result.cart).toEqual(cart);
  });
});
