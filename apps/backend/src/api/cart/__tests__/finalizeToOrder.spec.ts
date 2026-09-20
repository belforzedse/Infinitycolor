import { describe, it, expect, jest } from "@jest/globals";
import { finalizeToOrderHandler } from "../controllers/handlers/finalizeToOrder";
import { createCtx, createStrapiMock } from "../../../__tests__/helpers/test-utils";

const enableSnappayGateway = (strapi: any) => {
  strapi.entityService.findMany = jest
    .fn()
    .mockResolvedValue([
      { Title: "SnappPay", IsActive: true },
    ]);
};

describe("finalizeToOrder handler - inline billing address", () => {
  it("rejects when no addressId or addressPayload is provided", async () => {
    const { strapi } = createStrapiMock();
    enableSnappayGateway(strapi);
    const handler = finalizeToOrderHandler(strapi as any);

    const ctx = createCtx({
      request: { body: { shipping: 1, shippingCost: 0, gateway: "snappay" } },
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
    enableSnappayGateway(strapi);

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
          gateway: "snappay",
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
    const { strapi, registerService, registerQuery } = createStrapiMock();
    // A saved address is frozen into a private copy before the order is placed,
    // so the handler writes one row here on its way to finalization.
    registerQuery("api::local-user-address.local-user-address", {
      create: jest.fn(async () => ({ id: 777 })),
    });
    enableSnappayGateway(strapi);
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
          gateway: "snappay",
          attemptId: "attempt-shipping-1",
          quoteHash: "quote-shipping-1",
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

  it("resumes an identified checkout without re-validating shipping or address", async () => {
    const { strapi, registerService, registerQuery } = createStrapiMock();
    enableSnappayGateway(strapi);
    const finalizeCartToOrder = jest.fn(async () => ({
      success: false,
      message: "stop-after-resume-lookup",
    }));
    registerService("api::cart.cart", { finalizeCartToOrder });
    registerQuery("api::payment-attempt.payment-attempt", {
      findOne: jest.fn().mockResolvedValue({
        attemptId: "attempt-111459",
        quoteHash: "sha256:original",
        Gateway: "snappay",
        Status: "Redirected",
        order: { id: 111459 },
      }),
      update: jest.fn(),
    });

    const handler = finalizeToOrderHandler(strapi as any);
    const ctx = createCtx({
      request: {
        body: {
          gateway: "snappay",
          attemptId: "attempt-111459",
        },
      },
      state: { user: { id: 1 } },
    });

    await expect(handler(ctx)).rejects.toMatchObject({ status: 400 });

    expect(finalizeCartToOrder).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        gateway: "snappay",
        attemptId: "attempt-111459",
        quoteHash: "sha256:original",
      }),
    );
    expect(finalizeCartToOrder.mock.calls[0][1].shippingId).toBeUndefined();
    expect(finalizeCartToOrder.mock.calls[0][1].addressId).toBeUndefined();
  });
});
