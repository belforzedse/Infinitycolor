import { describe, it, expect, jest } from "@jest/globals";
import { finalizeToOrderHandler } from "../controllers/handlers/finalizeToOrder";
import { createCtx, createStrapiMock } from "../../../__tests__/helpers/test-utils";

describe("finalizeToOrder diagnostic response", () => {
  it.each(["insufficient_stock", "database_failure"])("forwards backend ownership and only a confirmed %s shortage", async (reason) => {
    const { strapi, registerService, registerQuery } = createStrapiMock();
    enableSnappayGateway(strapi);
    registerService("api::cart.cart", { finalizeCartToOrder: jest.fn(async () => ({
      success: false, message: "Test checkout failure", errorCode: "STOCK_RESERVATION_FAILED",
      telemetryOwner: "backend", details: { reason, privateDatabaseDetail: "never public" },
    })) });
    registerQuery("api::payment-attempt.payment-attempt", { findOne: jest.fn().mockResolvedValue({
      attemptId: "diagnostic-attempt", quoteHash: "test-quote", Gateway: "snappay", Status: "Redirected", order: { id: 42 },
    }), update: jest.fn() });
    const ctx = createCtx({ request: { body: { gateway: "snappay", attemptId: "diagnostic-attempt" } }, state: { user: { id: 1 } } });
    try { await finalizeToOrderHandler(strapi as any)(ctx); throw new Error("Expected refusal"); }
    catch (error: any) {
      expect(error.status).toBe(400);
      expect(error.payload.data.telemetryOwner).toBe("backend");
      expect(error.payload.data.details).toEqual(reason === "insufficient_stock" ? { reason } : undefined);
      expect(JSON.stringify(error.payload)).not.toContain("privateDatabaseDetail");
    }
  });
});

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
    const { strapi, registerService } = createStrapiMock();
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

describe("finalizeToOrder handler - checkout recipient", () => {
  const savedAddress = {
    id: 5,
    user: { id: 1 },
    shipping_city: { id: 10 },
    PostalCode: "4913795555",
    FullAddress: "Gorgan, Edalat 68",
    Description: "unit 2",
    FullName: null,
    Phone: null,
  };

  const setup = (address: Record<string, unknown> = savedAddress) => {
    const { strapi, registerService } = createStrapiMock();
    enableSnappayGateway(strapi);
    const finalizeCartToOrder = jest.fn(async () => ({ success: false, message: "stop" }));
    strapi.entityService.findOne = (jest.fn((uid: string) => {
      if (uid === "api::shipping.shipping") return { id: 1, Title: "Post" };
      if (uid === "api::local-user-address.local-user-address") return address;
      if (uid === "api::shipping-city.shipping-city") {
        return { id: 10, shipping_province: { id: 20, Title: "Golestan" } };
      }
      return null;
    }) as any);
    const create = jest.fn(async () => ({ id: 77 }));
    strapi.entityService.create = create as any;
    registerService("api::shipping.shipping", {
      calculateMethodForCart: jest.fn(async () => ({ code: "post", title: "Post", price: 0 })),
    });
    registerService("api::cart.cart", { finalizeCartToOrder });
    return { handler: finalizeToOrderHandler(strapi as any), create, finalizeCartToOrder };
  };

  const checkout = (body: Record<string, unknown>) =>
    createCtx({
      request: {
        body: {
          shipping: 1,
          gateway: "snappay",
          attemptId: "attempt-recipient",
          quoteHash: "sha256:recipient",
          ...body,
        },
      },
      state: { user: { id: 1 } },
    });

  it("links a per-order copy of a saved address carrying the typed recipient", async () => {
    const { handler, create, finalizeCartToOrder } = setup();

    await expect(
      handler(
        checkout({
          addressId: 5,
          recipient: { FullName: "  Hadis   Shabani ", Phone: "09121234567" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(create).toHaveBeenCalledWith("api::local-user-address.local-user-address", {
      data: expect.objectContaining({
        shipping_city: 10,
        PostalCode: "4913795555",
        FullAddress: "Gorgan, Edalat 68",
        Description: "unit 2",
        FullName: "Hadis Shabani",
        Phone: "09121234567",
        IsTemporary: true,
        user: 1,
      }),
    });
    expect(finalizeCartToOrder).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ addressId: 77 }),
    );
  });

  it("links the saved address itself when the recipient already matches it", async () => {
    const { handler, create, finalizeCartToOrder } = setup({
      ...savedAddress,
      FullName: "Hadis Shabani",
      Phone: "+989121234567",
    });

    await expect(
      handler(
        checkout({
          addressId: 5,
          recipient: { FullName: "Hadis Shabani", Phone: "09121234567" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(create).not.toHaveBeenCalled();
    expect(finalizeCartToOrder).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ addressId: 5 }),
    );
  });

  it("links the saved address when no recipient is sent", async () => {
    const { handler, create, finalizeCartToOrder } = setup();

    await expect(handler(checkout({ addressId: 5 }))).rejects.toMatchObject({ status: 400 });

    expect(create).not.toHaveBeenCalled();
    expect(finalizeCartToOrder).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ addressId: 5 }),
    );
  });

  it("stores the recipient on an inline address when the payload has no name", async () => {
    const { handler, create } = setup();

    await expect(
      handler(
        checkout({
          addressPayload: {
            shipping_city: 10,
            PostalCode: "4913795555",
            FullAddress: "Gorgan, Edalat 68",
            save: false,
          },
          recipient: { FullName: "Hadis Shabani", Phone: "09121234567" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith("api::local-user-address.local-user-address", {
      data: expect.objectContaining({
        FullName: "Hadis Shabani",
        Phone: "09121234567",
        IsTemporary: true,
      }),
    });
  });
});
