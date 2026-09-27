/**
 * A variation with no price must never be bought. Order 116612 took two units of
 * a just-generated variation at 0 because Postgres returns bigint Price as the
 * string "0", which slipped past a truthiness check, and cart add never looked
 * at the price at all.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { addCartItemOp } from "../addCartItem";
import { createOrderAndItems } from "../../lib/order";

const variation = (overrides: Record<string, unknown> = {}) => ({
  id: 31779,
  IsPublished: true,
  SKU: "GEN-4955",
  Price: "0",
  DiscountPrice: null,
  product: { id: 4955, Title: "وست جین N00219", Status: "Active" },
  product_stock: { id: 1, Count: 31, ReservedCount: 0 },
  ...overrides,
});

const strapiWith = (row: unknown) => {
  const create = jest.fn();
  const query = { findOne: jest.fn(async (args: any) => (args?.populate ? row : null)) };
  return {
    strapi: {
      db: { query: jest.fn(() => query) },
      entityService: { create, update: jest.fn() },
      log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    } as any,
    create,
  };
};

describe("price-0 variations are not for sale", () => {
  it("refuses to add an unpriced variation to the cart", async () => {
    const { strapi, create } = strapiWith(variation());
    await expect(addCartItemOp(strapi, 7, 31779, 1)).resolves.toMatchObject({ success: false });
    expect(create).not.toHaveBeenCalled();
  });

  it("still adds a priced variation", async () => {
    const { strapi, create } = strapiWith(variation({ Price: "3499000" }));
    await expect(addCartItemOp(strapi, 7, 31779, 1)).resolves.toMatchObject({ success: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses to create an order containing an unpriced variation", async () => {
    const { strapi } = strapiWith(variation());
    await expect(
      createOrderAndItems(strapi, 1, { cart_items: [{ id: 5, Count: 2, product_variation: variation() }] }, 0),
    ).rejects.toThrow("INVALID_PRICE");
  });
});
