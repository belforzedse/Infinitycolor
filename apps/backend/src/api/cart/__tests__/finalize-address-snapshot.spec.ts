import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { finalizeToOrderHandler } from "../controllers/handlers/finalizeToOrder";
import { createCtx, createStrapiMock } from "../../../__tests__/helpers/test-utils";

/**
 * An order must own its destination rather than borrow the shopper's address
 * book. A book row stays editable and deletable forever, so linking it directly
 * lets a later edit rewrite where a shipped order went -- and a later delete
 * blank it outright, since the link row cascades away with the address.
 */

const ADDRESS_UID = "api::local-user-address.local-user-address";

const SAVED_ADDRESS = {
  id: 5,
  user: { id: 1 },
  shipping_city: { id: 10 },
  PostalCode: "1234567890",
  FullAddress: "نشانی دفترچه",
  FullName: "گیرنده",
  Phone: "+989121111111",
  Description: "خانه",
  IsTemporary: false,
};

function setup(address: any) {
  const { strapi, registerService, registerQuery } = createStrapiMock();
  strapi.entityService.findMany = jest.fn().mockResolvedValue([
    { Title: "SnappPay", IsActive: true },
  ]) as any;
  strapi.entityService.findOne = jest.fn((uid: string) => {
    if (uid === "api::shipping.shipping") return { id: 1, Title: "Mock Shipping" };
    if (uid === ADDRESS_UID) return address;
    return null;
  }) as any;

  const snapshotCreate = jest.fn().mockResolvedValue({ id: 777 });
  registerQuery(ADDRESS_UID, { create: snapshotCreate });

  registerService("api::shipping.shipping", {
    calculateMethodForCart: jest.fn(async () => ({
      id: 1,
      code: "dynamic-method",
      title: "Dynamic Method",
      price: 25000,
    })),
  });
  const finalizeCartToOrder = jest.fn(async () => ({
    success: false,
    message: "stop-before-payment",
  }));
  registerService("api::cart.cart", { finalizeCartToOrder });

  return { strapi, snapshotCreate, finalizeCartToOrder };
}

const body = (overrides: Record<string, any> = {}) => ({
  request: {
    body: {
      shipping: 1,
      shippingCost: 0,
      addressId: 5,
      gateway: "snappay",
      attemptId: "attempt-snapshot-1",
      quoteHash: "quote-snapshot-1",
      ...overrides,
    },
  },
  state: { user: { id: 1 } },
});

describe("finalizeToOrder - delivery address snapshot", () => {
  beforeEach(() => jest.clearAllMocks());

  it("freezes a saved address into a private copy and orders against that copy", async () => {
    const { strapi, snapshotCreate, finalizeCartToOrder } = setup(SAVED_ADDRESS);
    const handler = finalizeToOrderHandler(strapi as any);

    await expect(handler(createCtx(body()))).rejects.toMatchObject({ status: 400 });

    expect(snapshotCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          IsTemporary: true,
          shipping_city: 10,
          PostalCode: "1234567890",
          FullAddress: "نشانی دفترچه",
          FullName: "گیرنده",
          Phone: "+989121111111",
          user: 1,
        }),
      }),
    );
    expect(finalizeCartToOrder).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ addressId: 777 }),
    );
  });

  it("copies a non-conforming postal code verbatim instead of rejecting it", async () => {
    // 209 live rows carry fewer than 10 digits; `update` never validated them, so
    // freezing history must not be the thing that starts failing on them.
    const { strapi, snapshotCreate } = setup({ ...SAVED_ADDRESS, PostalCode: "12345" });
    const handler = finalizeToOrderHandler(strapi as any);

    await expect(handler(createCtx(body()))).rejects.toMatchObject({ status: 400 });

    expect(snapshotCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ PostalCode: "12345" }) }),
    );
  });

  it("does not re-copy a row that was already minted for this checkout", async () => {
    const { strapi, snapshotCreate, finalizeCartToOrder } = setup({
      ...SAVED_ADDRESS,
      IsTemporary: true,
    });
    const handler = finalizeToOrderHandler(strapi as any);

    await expect(handler(createCtx(body()))).rejects.toMatchObject({ status: 400 });

    expect(snapshotCreate).not.toHaveBeenCalled();
    expect(finalizeCartToOrder).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ addressId: 5 }),
    );
  });

  it("still refuses an address owned by someone else, before any copy is made", async () => {
    const { strapi, snapshotCreate, finalizeCartToOrder } = setup({
      ...SAVED_ADDRESS,
      user: { id: 42 },
    });
    const handler = finalizeToOrderHandler(strapi as any);

    // Which of ADDRESS_UNAUTHORIZED / ADDRESS_VALIDATION_FAILED surfaces depends on
    // whether ctx.badRequest throws -- pre-existing behaviour of the ownership
    // block that this change does not touch. What matters here is that the
    // rejection happens before anything is written and nothing reaches the order.
    await expect(handler(createCtx(body()))).rejects.toMatchObject({ status: 400 });

    expect(snapshotCreate).not.toHaveBeenCalled();
    expect(finalizeCartToOrder).not.toHaveBeenCalled();
  });
});
