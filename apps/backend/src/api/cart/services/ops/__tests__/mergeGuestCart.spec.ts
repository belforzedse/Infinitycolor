import { mergeGuestCart, normalizeGuestMergeItems } from "../mergeGuestCart";

describe("guest cart merge", () => {
  it("validates and deduplicates variation quantities", () => {
    expect(
      normalizeGuestMergeItems([
        { productVariationId: 7, quantity: 2 },
        { productVariationId: 7, quantity: 3 },
      ]),
    ).toEqual([{ productVariationId: 7, quantity: 5 }]);
    expect(() => normalizeGuestMergeItems([{ productVariationId: 0, quantity: 1 }])).toThrow(
      /positive integers/,
    );
  });

  it("applies only available stock and replays without doubling quantities", async () => {
    const carts: any[] = [{ id: 1, user: 42, Status: "Pending" }];
    const cartItems: any[] = [{ id: 1, cart: 1, product_variation: 7, Count: 1, Sum: 100 }];
    const merges: any[] = [];
    const variations: Record<number, any> = {
      7: {
        id: 7,
        IsPublished: true,
        Price: 100,
        product: { id: 1, Status: "Active" },
        product_stock: { Count: 3, reservedCount: 0 },
      },
      8: {
        id: 8,
        IsPublished: false,
        Price: 200,
        product: { id: 2, Status: "Active" },
        product_stock: { Count: 10, reservedCount: 0 },
      },
    };

    const queryFor = (uid: string) => ({
      findOne: jest.fn(async ({ where }: any) => {
        if (uid.includes("guest-cart-merge")) {
          return merges.find((row) => row.MergeId === where.MergeId && row.user === where.user) || null;
        }
        if (uid === "api::cart.cart") return carts.find((row) => row.user === where.user) || null;
        if (uid === "api::cart-item.cart-item") {
          return cartItems.find(
            (row) => row.cart === where.cart && row.product_variation === where.product_variation,
          ) || null;
        }
        if (uid === "api::product-variation.product-variation") return variations[where.id] || null;
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const target = uid.includes("guest-cart-merge") ? merges : uid === "api::cart.cart" ? carts : cartItems;
        const row = { id: target.length + 1, ...data };
        target.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const target = uid === "api::cart.cart" ? carts : cartItems;
        const index = target.findIndex((row) => row.id === where.id);
        target[index] = { ...target[index], ...data };
        return target[index];
      }),
    });
    const strapi = {
      db: {
        transaction: jest.fn(async (fn: any) => fn({ trx: { raw: jest.fn() } })),
        query: jest.fn(queryFor),
      },
    } as any;

    const first = await mergeGuestCart(strapi, 42, "merge-12345678", [
      { productVariationId: 7, quantity: 5 },
      { productVariationId: 8, quantity: 1 },
    ]);
    const replay = await mergeGuestCart(strapi, 42, "merge-12345678", [
      { productVariationId: 7, quantity: 5 },
    ]);

    expect(first.adjusted).toEqual([
      expect.objectContaining({ productVariationId: 7, appliedQuantity: 2, resultingQuantity: 3 }),
    ]);
    expect(first.rejected).toEqual([
      expect.objectContaining({ productVariationId: 8, reason: "UNAVAILABLE" }),
    ]);
    expect(cartItems.find((item) => item.product_variation === 7)?.Count).toBe(3);
    expect(replay.replayed).toBe(true);
    expect(cartItems.find((item) => item.product_variation === 7)?.Count).toBe(3);
  });
});
