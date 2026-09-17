import { checkCartStockOp } from "../checkCartStock";

jest.mock("../../lib/stock", () => {
  const actual = jest.requireActual("../../lib/stock");
  return {
    ...actual,
  };
});

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

    expect(removeCartItem).toHaveBeenCalledWith(10);
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

    expect(removeCartItem).toHaveBeenCalledWith(10);
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

    expect(updateCartItem).toHaveBeenCalledWith(30, 2);
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
});
