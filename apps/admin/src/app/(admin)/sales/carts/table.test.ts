import { getCartCustomerName, getCartItems, type Cart } from "./table";

describe("cart table normalization", () => {
  it.each([null, undefined, "invalid", {}])(
    "treats a missing or malformed cart-items relation as empty: %p",
    (data) => {
      const cart = { attributes: { cart_items: { data } } } as unknown as Cart;
      expect(getCartItems(cart)).toEqual([]);
    },
  );

  it("preserves populated cart items", () => {
    const items = [{ id: "item-1", attributes: { Sum: "120000" } }];
    const cart = {
      attributes: { cart_items: { data: items } },
    } as unknown as Cart;
    expect(getCartItems(cart)).toBe(items);
  });

  it("renders the bounded cart-report customer name", () => {
    const cart = {
      attributes: {
        user: {
          data: {
            attributes: {
              user_info: {
                data: { attributes: { FirstName: "سارا", LastName: "کریمی" } },
              },
            },
          },
        },
      },
    } as unknown as Cart;
    expect(getCartCustomerName(cart)).toBe("سارا کریمی");
  });

  it("falls back when the customer relation is missing", () => {
    expect(getCartCustomerName({ attributes: { user: { data: null } } } as unknown as Cart)).toBe(
      " - ",
    );
  });
});
