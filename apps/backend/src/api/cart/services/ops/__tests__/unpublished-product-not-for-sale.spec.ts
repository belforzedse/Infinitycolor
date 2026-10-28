/**
 * A product can leave the store while it sits in someone's cart: moved back to
 * draft, scheduled, or moved to Trash. The cart and checkout re-check the one
 * visibility rule (utils/productVisibility.ts) server-side on every write, so
 * stale cart state never buys an unpublished product.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { addCartItemOp } from "../addCartItem";
import { updateCartItemOp } from "../updateCartItem";
import { createOrderAndItems } from "../../lib/order";

const variation = (product: Record<string, unknown>) => ({
  id: 501,
  IsPublished: true,
  SKU: "SKU-501",
  Price: "3499000",
  DiscountPrice: null,
  product: { id: 50, Title: "پیراهن آبی", ...product },
  product_stock: { id: 1, Count: 10, ReservedCount: 0 },
});

const TRASHED = { Status: "InActive", removedAt: "2026-09-27T08:00:00.000Z" };
const LEGACY_TRASHED = { Status: "Active", removedAt: "2026-09-27T08:00:00.000Z" };
const DRAFT = { Status: "InActive", removedAt: null };
const SCHEDULED = { Status: "Scheduled", removedAt: null };

const strapiWith = (row: unknown) => {
  const create = jest.fn();
  const update = jest.fn();
  const query = { findOne: jest.fn(async (args: any) => (args?.populate ? row : null)) };
  return {
    strapi: {
      db: { query: jest.fn(() => query) },
      entityService: { create, update },
      log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    } as any,
    create,
    update,
  };
};

describe("products that left the store are not for sale", () => {
  it.each([
    ["in Trash", TRASHED, "Product is no longer available"],
    ["in Trash with a legacy Active status", LEGACY_TRASHED, "Product is no longer available"],
    ["moved to draft", DRAFT, "Product is currently unavailable"],
    ["scheduled for later", SCHEDULED, "Product is currently unavailable"],
  ])("refuses to add a product %s to the cart", async (_label, product, message) => {
    const { strapi, create } = strapiWith(variation(product));
    await expect(addCartItemOp(strapi, 7, 501, 1)).resolves.toEqual({ success: false, message });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["in Trash", TRASHED],
    ["moved to draft", DRAFT],
    ["scheduled for later", SCHEDULED],
  ])("refuses to change the quantity of a cart line whose product is %s", async (_label, product) => {
    const cartItem = { id: 9, Count: 1, cart: { id: 3, user: { id: 7 } }, product_variation: variation(product) };
    const { strapi, update } = strapiWith(cartItem);
    await expect(updateCartItemOp(strapi, 9, 2, 7)).resolves.toMatchObject({ success: false });
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ["PRODUCT_DELETED", TRASHED],
    ["PRODUCT_INACTIVE", DRAFT],
    ["PRODUCT_INACTIVE", SCHEDULED],
  ])("refuses to create an order (%s) from a stale cart", async (code, product) => {
    const line = variation(product);
    const { strapi } = strapiWith(line);
    await expect(
      createOrderAndItems(strapi, 1, { cart_items: [{ id: 5, Count: 1, product_variation: line }] }, 0),
    ).rejects.toThrow(code);
  });

  it("still sells a published product", async () => {
    const { strapi, create } = strapiWith(variation({ Status: "Active", removedAt: null }));
    await expect(addCartItemOp(strapi, 7, 501, 1)).resolves.toMatchObject({ success: true });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
