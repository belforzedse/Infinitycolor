import { getOrCreateUserCart } from "../get-user-cart";

jest.mock("../user-cart-identity", () => ({
  resolveUserCartId: jest.fn().mockResolvedValue(3),
}));

const line = (id: number, product: object, variation: object = {}) => ({
  id,
  Count: 1,
  product_variation: { id: id * 10, IsPublished: true, product: { id, Title: `P${id}`, ...product }, ...variation },
});

function strapiWithCart() {
  const cart = {
    id: 3,
    cart_items: [
      line(1, { Status: "Active", removedAt: null }),
      line(2, { Status: "InActive", removedAt: null }),
      line(3, { Status: "Active", removedAt: null }, { IsPublished: false }),
      { id: 4, Count: 1, product_variation: null },
    ],
  };
  return {
    db: { query: jest.fn(() => ({ findOne: jest.fn().mockResolvedValue(structuredClone(cart)) })) },
    log: { warn: jest.fn() },
  } as any;
}

describe("getOrCreateUserCart", () => {
  it("hides lines whose product left the store from ordinary reads", async () => {
    const cart = await getOrCreateUserCart(strapiWithCart(), 7);
    expect(cart.cart_items.map((item: { id: number }) => item.id)).toEqual([1]);
  });

  it("keeps them for the stock check, which removes and names them", async () => {
    const cart = await getOrCreateUserCart(strapiWithCart(), 7, { includeUnavailable: true });
    // A line with no variation or product is still dropped: there is nothing to name.
    expect(cart.cart_items.map((item: { id: number }) => item.id)).toEqual([1, 2, 3]);
  });
});
