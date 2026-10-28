import { createCheckoutQuote } from "../checkout-quote";

const cart = {
  id: 71,
  cart_items: [
    {
      Count: 2,
      product_variation: { id: 9, Price: 100_000, DiscountPrice: 80_000 },
    },
    {
      Count: 1,
      product_variation: { id: 3, Price: 50_000 },
    },
  ],
};

const createStrapi = (generalDiscounts: any[] = []) =>
  ({
    entityService: {
      findMany: jest.fn().mockResolvedValue(generalDiscounts),
    },
    log: { debug: jest.fn() },
  }) as any;

describe("createCheckoutQuote", () => {
  it("produces a stable server-owned quote independent of cart item order", async () => {
    const quoteA = await createCheckoutQuote(createStrapi(), 12, {
      cart,
      shippingId: 4,
      shippingCost: 20_000,
      gateway: "wallet",
    });
    const quoteB = await createCheckoutQuote(createStrapi(), 12, {
      cart: { ...cart, cart_items: [...cart.cart_items].reverse() },
      shippingId: 4,
      shippingCost: 20_000,
      gateway: "wallet",
    });

    expect(quoteA).toEqual(quoteB);
    expect(quoteA.financialSummary).toEqual({
      subtotal: 210_000,
      discount: 0,
      tax: 0,
      shipping: 20_000,
      total: 230_000,
    });
    expect(quoteA.lineItems.map((item) => item.variationId)).toEqual([3, 9]);
    expect(quoteA.quoteHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("changes the quote hash when a price, quantity, gateway, or shipping amount changes", async () => {
    const baseline = await createCheckoutQuote(createStrapi(), 12, {
      cart,
      shippingId: 4,
      shippingCost: 20_000,
      gateway: "wallet",
    });
    const changedPrice = await createCheckoutQuote(createStrapi(), 12, {
      cart: {
        ...cart,
        cart_items: [
          { ...cart.cart_items[0], product_variation: { id: 9, Price: 100_000, DiscountPrice: 81_000 } },
          cart.cart_items[1],
        ],
      },
      shippingId: 4,
      shippingCost: 20_000,
      gateway: "wallet",
    });
    const changedShipping = await createCheckoutQuote(createStrapi(), 12, {
      cart,
      shippingId: 4,
      shippingCost: 21_000,
      gateway: "wallet",
    });
    const changedGateway = await createCheckoutQuote(createStrapi(), 12, {
      cart,
      shippingId: 4,
      shippingCost: 20_000,
      gateway: "zarinpal",
    });

    expect(new Set([
      baseline.quoteHash,
      changedPrice.quoteHash,
      changedShipping.quoteHash,
      changedGateway.quoteHash,
    ])).toHaveProperty("size", 4);
  });

  it("applies the active promotion to the persisted financial summary", async () => {
    const quote = await createCheckoutQuote(
      createStrapi([{ id: 8, MinimumAmount: 100_000, IsPercentage: true, Amount: 10 }]),
      12,
      { cart, shippingId: 4, shippingCost: 20_000, gateway: "wallet" },
    );

    expect(quote.appliedGeneralDiscountId).toBe(8);
    expect(quote.financialSummary).toEqual({
      subtotal: 210_000,
      discount: 21_000,
      tax: 0,
      shipping: 20_000,
      total: 209_000,
    });
  });

  it("refuses to quote a variation that has no price", async () => {
    await expect(
      createCheckoutQuote(createStrapi(), 12, {
        cart: {
          ...cart,
          cart_items: [{ ...cart.cart_items[0], product_variation: { id: 9, Price: "0" } }],
        },
        shippingId: 4,
        shippingCost: 20_000,
        gateway: "wallet",
      }),
    ).rejects.toThrow("INVALID_PRICE");
  });

  it("quotes the base price when a stray zero discount is stored", async () => {
    const quote = await createCheckoutQuote(createStrapi(), 12, {
      cart: {
        ...cart,
        cart_items: [
          { ...cart.cart_items[0], product_variation: { id: 9, Price: "1999000", DiscountPrice: "0" } },
        ],
      },
      shippingId: 4,
      shippingCost: 20_000,
      gateway: "wallet",
    });
    expect(quote.lineItems[0].unitPrice).toBe(1_999_000);
  });

  it("changes the quote hash when a coupon is applied or removed", async () => {
    const strapi = createStrapi();
    strapi.entityService.findMany = jest.fn(async (uid: string) => {
      if (uid === "api::discount.discount") {
        return [{ id: 99, Code: "SAVE10", Type: "Cash", Amount: 10_000, IsActive: true }];
      }
      return [];
    });

    const withoutCoupon = await createCheckoutQuote(strapi, 12, {
      cart,
      shippingId: 4,
      shippingCost: 20_000,
      gateway: "mellat",
    });
    const withCoupon = await createCheckoutQuote(strapi, 12, {
      cart,
      shippingId: 4,
      shippingCost: 20_000,
      gateway: "mellat",
      discountCode: "SAVE10",
    });
    const removedCoupon = await createCheckoutQuote(strapi, 12, {
      cart,
      shippingId: 4,
      shippingCost: 20_000,
      gateway: "mellat",
    });

    expect(withCoupon.quoteHash).not.toBe(withoutCoupon.quoteHash);
    expect(withCoupon.financialSummary.discount).toBe(10_000);
    expect(removedCoupon.quoteHash).toBe(withoutCoupon.quoteHash);
    expect(removedCoupon.financialSummary.total).toBe(withoutCoupon.financialSummary.total);
  });
});
