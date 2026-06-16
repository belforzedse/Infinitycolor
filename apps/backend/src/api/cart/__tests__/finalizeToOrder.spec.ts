import { describe, it, expect, jest } from "@jest/globals";
import { finalizeToOrderHandler } from "../controllers/handlers/finalizeToOrder";
import { createCtx, createStrapiMock } from "../../../__tests__/helpers/test-utils";

describe("finalizeToOrder handler - inline billing address", () => {
  it("rejects when no addressId or addressPayload is provided", async () => {
    const { strapi } = createStrapiMock();
    const handler = finalizeToOrderHandler(strapi as any);

    const ctx = createCtx({
      request: { body: { shipping: 1, shippingCost: 0 } },
      state: { user: { id: 1 } },
    });

    await expect(handler(ctx)).rejects.toMatchObject({
      status: 400,
      payload: expect.objectContaining({
        data: expect.objectContaining({ errorCode: "ADDRESS_REQUIRED" }),
      }),
    });
  });

  it("rejects inline address with invalid postal code", async () => {
    const { strapi, registerService } = createStrapiMock();

    // Minimal shipping + city mocks for validation steps
    strapi.entityService.findOne = (jest.fn((uid: string) => {
      if (uid === "api::shipping.shipping") return { id: 1, Title: "Mock Shipping" };
      if (uid === "api::shipping-city.shipping-city")
        return { id: 10, shipping_province: { id: 20, Title: "Tehran" } };
      return null;
    }) as any);

    // Cart service is never called in this validation path, but register stub to avoid undefined
    registerService("api::cart.cart", {
      finalizeCartToOrder: jest.fn(),
    });

    const handler = finalizeToOrderHandler(strapi as any);
    const ctx = createCtx({
      request: {
        body: {
          shipping: 1,
          shippingCost: 0,
          addressPayload: {
            shipping_city: 10,
            PostalCode: "123", // invalid
            FullAddress: "Test address",
            save: false,
          },
        },
      },
      state: { user: { id: 1 } },
    });

    await expect(handler(ctx)).rejects.toMatchObject({
      status: 400,
      payload: expect.objectContaining({
        data: expect.objectContaining({ errorCode: "INVALID_POSTAL_CODE" }),
      }),
    });
  });

  it("passes backend-calculated shipping cost to cart finalization", async () => {
    const { strapi, registerService } = createStrapiMock();
    const finalizeCartToOrder = jest.fn(async () => ({
      success: false,
      message: "stop-before-payment",
    }));

    strapi.entityService.findOne = (jest.fn((uid: string) => {
      if (uid === "api::shipping.shipping") return { id: 1, Title: "Mock Shipping" };
      if (uid === "api::local-user-address.local-user-address") {
        return {
          id: 5,
          user: { id: 1 },
          shipping_city: { id: 10 },
        };
      }
      return null;
    }) as any);

    registerService("api::shipping.shipping", {
      calculateMethodForCart: jest.fn(async () => ({
        id: 1,
        code: "dynamic-method",
        title: "Dynamic Method",
        price: 25000,
      })),
    });
    registerService("api::cart.cart", {
      finalizeCartToOrder,
    });

    const handler = finalizeToOrderHandler(strapi as any);
    const ctx = createCtx({
      request: {
        body: {
          shipping: 1,
          shippingCost: 999999,
          addressId: 5,
        },
      },
      state: { user: { id: 1 } },
    });

    await expect(handler(ctx)).rejects.toMatchObject({
      status: 400,
      payload: expect.objectContaining({
        data: expect.objectContaining({ success: false }),
      }),
    });

    expect(finalizeCartToOrder).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        shippingId: 1,
        shippingCost: 25000,
        shippingMethodCode: "dynamic-method",
        shippingMethodTitle: "Dynamic Method",
      }),
    );
  });
});
