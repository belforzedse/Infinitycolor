import { finalizeToOrderHandler } from "../controllers/handlers/finalizeToOrder";

jest.mock("../../payment-gateway/services/mellat-coordinator", () => ({
  prepareMellatInitiation: jest.fn().mockResolvedValue(undefined),
  recordMellatInitiation: jest.fn().mockResolvedValue(undefined),
}));
import {
  cancelOrderAndRelease,
  ensurePaymentGateway,
  requestMellatPayment,
  requestSamanPayment,
} from "../controllers/handlers/gateway-helpers";
import { settleOrderWithWallet } from "../controllers/handlers/wallet-settlement";
import { consumeCheckoutCartLinesSafely } from "../services/lib/order-cart-cleanup";
import {
  claimPaymentAttemptForInitiation,
  findPaymentAttempt,
  updatePaymentAttempt,
} from "../../payment-attempt/services/payment-attempt";

jest.mock("../controllers/handlers/gateway-helpers", () => ({
  cancelOrderAndRelease: jest.fn().mockResolvedValue(undefined),
  ensurePaymentGateway: jest.fn().mockResolvedValue(undefined),
  requestMellatPayment: jest.fn(),
  requestSamanPayment: jest.fn(),
  requestZarinPalPayment: jest.fn(),
  // Deliberately real: whether an initiation failure is a provider verdict or an
  // unknown outcome decides if the order is cancelled, so these tests exercise
  // the actual classification rather than a stub of it.
  classifyGatewayInitiationOutcome: jest.requireActual(
    "../controllers/handlers/gateway-helpers",
  ).classifyGatewayInitiationOutcome,
}));

jest.mock("../controllers/handlers/wallet-settlement", () => ({
  settleOrderWithWallet: jest.fn().mockResolvedValue({
    success: true,
    reference: "wallet-order-42-checkout-attempt",
    newBalance: 5_000_000,
  }),
}));

jest.mock("../services/lib/order-cart-cleanup", () => ({
  consumeCheckoutCartLinesSafely: jest.fn().mockResolvedValue(true),
}));

jest.mock("../../payment-attempt/services/payment-attempt", () => ({
  claimPaymentAttemptForInitiation: jest.fn().mockResolvedValue(true),
  findPaymentAttempt: jest.fn().mockResolvedValue(null),
  updatePaymentAttempt: jest.fn().mockResolvedValue({}),
  paymentAttemptResponse: jest.fn((attempt: any) => ({
    success: attempt?.Status === "Redirected" || attempt?.Status === "Succeeded",
    attemptId: attempt?.attemptId,
    paymentStatus: attempt?.Status,
    errorCode: attempt?.Status === "Pending" ? "PAYMENT_IN_PROGRESS" : undefined,
  })),
}));

type StrapiMockHelpers = ReturnType<typeof createStrapiMock>;

// Creates a lightweight Koa-like ctx with error helpers that throw, allowing tests to assert on badRequest/unauthorized behaviours.
const createCtx = (overrides: Partial<any> = {}) => {
  const requestOverrides = overrides.request || {};
  const ctx: any = {
    state: {
      user: { id: 1 },
      ...overrides.state,
    },
    badRequest: jest.fn((message: string, payload?: unknown) => {
      const error: any = new Error(message);
      error.status = 400;
      error.payload = payload;
      throw error;
    }),
    unauthorized: jest.fn((message: string) => {
      const error: any = new Error(message);
      error.status = 401;
      throw error;
    }),
    ...overrides,
    request: {
      header: {},
      ...requestOverrides,
      body: {
        attemptId: "checkout-attempt",
        quoteHash: "checkout-quote",
        ...(requestOverrides.body || {}),
      },
    },
  };

  return ctx;
};

// Minimal Strapi mock with registries so tests can attach per-UID services/queries.
const createStrapiMock = () => {
  const serviceMap: Record<string, any> = {
    "api::shipping.shipping": {
      calculateMethodForCart: jest.fn(async (_userId: number, shippingId: number | string) => ({
        id: Number(shippingId),
        code: `shipping-${shippingId}`,
        title: "Test Shipping",
        price: 0,
      })),
    },
  };
  const queryMap: Record<string, any> = {};
  const strapi: any = {
    log: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
    entityService: {
      findOne: jest.fn(),
      findMany: jest.fn().mockResolvedValue([
        { Title: "Wallet", IsActive: true },
        { Title: "Mellat", IsActive: true },
        { Title: "Saman", IsActive: true },
        { Title: "SnappPay", IsActive: true },
      ]),
      create: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(null),
    },
    service: jest.fn((uid: string) => serviceMap[uid]),
    db: {
      query: jest.fn((uid: string) => queryMap[uid]),
      connection: {
        raw: jest.fn().mockResolvedValue({ rows: [] }),
      },
    },
  };

  const registerService = (uid: string, impl: any) => {
    serviceMap[uid] = impl;
  };

  const registerQuery = (uid: string, impl: any) => {
    queryMap[uid] = impl;
  };

  return { strapi, registerService, registerQuery };
};

// Convenience helper for supplying multiple entityService.findOne implementations in one go.
const mockEntityFindOne = (
  strapi: StrapiMockHelpers["strapi"],
  implementations: Record<string, (...args: any[]) => any>,
) => {
  (strapi.entityService.findOne as jest.Mock).mockImplementation(
    async (uid: string, ...args: any[]) => {
      const handler = implementations[uid];
      return handler ? handler(...args) : null;
    },
  );
};

const mockedRequestMellatPayment = requestMellatPayment as jest.MockedFunction<
  typeof requestMellatPayment
>;
const mockedRequestSamanPayment = requestSamanPayment as jest.MockedFunction<
  typeof requestSamanPayment
>;
const mockedCancelOrderAndRelease = cancelOrderAndRelease as jest.MockedFunction<
  typeof cancelOrderAndRelease
>;
const mockedSettleOrderWithWallet = settleOrderWithWallet as jest.MockedFunction<
  typeof settleOrderWithWallet
>;
const mockedClaimPaymentAttempt = claimPaymentAttemptForInitiation as jest.MockedFunction<
  typeof claimPaymentAttemptForInitiation
>;
const mockedFindPaymentAttempt = findPaymentAttempt as jest.MockedFunction<
  typeof findPaymentAttempt
>;
const mockedUpdatePaymentAttempt = updatePaymentAttempt as jest.MockedFunction<
  typeof updatePaymentAttempt
>;
const mockedEnsurePaymentGateway = ensurePaymentGateway as jest.MockedFunction<
  typeof ensurePaymentGateway
>;

describe("finalizeToOrderHandler", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MELLAT_TERMINAL_ID: "test-terminal",
      MELLAT_USERNAME: "test-user",
      MELLAT_PASSWORD: "test-password",
      SAMAN_TERMINAL_ID: "test-terminal",
      SAMAN_USERNAME: "test-user",
      SAMAN_PASSWORD: "test-password",
      SNAPPAY_CLIENT_SECRET: "test-secret",
      SNAPPAY_PASSWORD: "test-password",
    };
    jest.clearAllMocks();
    mockedClaimPaymentAttempt.mockResolvedValue(true);
    mockedFindPaymentAttempt.mockResolvedValue(null);
    mockedUpdatePaymentAttempt.mockResolvedValue({} as any);
    mockedSettleOrderWithWallet.mockResolvedValue({
      success: true,
      reference: "wallet-order-42-checkout-attempt",
      newBalance: 5_000_000,
    });
    mockedCancelOrderAndRelease.mockResolvedValue(undefined);
    mockedEnsurePaymentGateway.mockResolvedValue(undefined as any);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("rejects the request when required shipping data is missing", async () => {
    const { strapi } = createStrapiMock();
    const handler = finalizeToOrderHandler(strapi);
    const ctx = createCtx({
      request: {
        body: {
          addressId: 10,
          paymentToken: "must-never-reach-logs",
        },
      },
    });

    await expect(handler(ctx)).rejects.toMatchObject({
      message: "روش ارسال الزامی است",
      status: 400,
    });

    expect(ctx.badRequest).toHaveBeenCalledWith(
      "روش ارسال الزامی است",
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: "SHIPPING_REQUIRED" }),
      }),
    );
    expect(strapi.entityService.findOne).not.toHaveBeenCalled();
    expect(strapi.log.error).toHaveBeenCalledWith(
      "Error in finalizeToOrder:",
      expect.objectContaining({
        requestBody: expect.objectContaining({
          paymentToken: "[redacted]",
        }),
      }),
    );
  });

  it("rejects the request when the shipping method cannot be found", async () => {
    const { strapi } = createStrapiMock();
    mockEntityFindOne(strapi, {
      "api::shipping.shipping": () => null,
    });
    const handler = finalizeToOrderHandler(strapi);
    const ctx = createCtx({
      request: { body: { shipping: 99, addressId: 1 } },
    });

    await expect(handler(ctx)).rejects.toMatchObject({
      message: "خطا در بررسی روش ارسال",
    });

    expect(ctx.badRequest).toHaveBeenCalledWith(
      "روش ارسال انتخاب شده معتبر نیست",
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: "INVALID_SHIPPING" }),
      }),
    );
  });

  it("returns PAYMENT_GATEWAY_DISABLED when selected gateway is disabled in backend", async () => {
    const { strapi, registerService } = createStrapiMock();
    registerService("api::cart.cart", {
      finalizeCartToOrder: jest.fn().mockResolvedValue({
        success: true,
        order: { id: 160 },
        contract: { id: 170, Amount: 200_000 },
        financialSummary: { payable: 200_000 },
      }),
      clearCart: jest.fn(),
    });

    (strapi.entityService.findMany as jest.Mock).mockResolvedValue([
      { Title: "SnappPay", IsActive: false },
    ]);

    mockEntityFindOne(strapi, {
      "api::shipping.shipping": () => ({ id: 3 }),
      "api::local-user-address.local-user-address": () => ({
        id: 22,
        shipping_city: {},
        user: { id: 1 },
      }),
    });

    const ctx = createCtx({
      request: {
        body: {
          shipping: 3,
          addressId: 22,
          gateway: "snappay",
        },
      },
    });

    const handler = finalizeToOrderHandler(strapi);
    await expect(handler(ctx)).rejects.toMatchObject({
      message: "درگاه پرداخت انتخاب‌شده غیرفعال است.",
      status: 400,
    });

    expect(ctx.badRequest).toHaveBeenCalledWith(
      "درگاه پرداخت انتخاب‌شده غیرفعال است.",
      expect.objectContaining({
        data: expect.objectContaining({
          success: false,
          errorCode: "PAYMENT_GATEWAY_DISABLED",
          gateway: "snappay",
        }),
      }),
    );

    expect(mockedRequestSamanPayment).not.toHaveBeenCalled();
    expect(mockedRequestMellatPayment).not.toHaveBeenCalled();
  });

  it("settles the order immediately when wallet funding succeeds", async () => {
    const { strapi, registerService } = createStrapiMock();
    const cartService = {
      finalizeCartToOrder: jest.fn().mockResolvedValue({
        success: true,
        order: { id: 42 },
        contract: { id: 7, Amount: 250_000 },
        financialSummary: { total: 250_000, payable: 250_000, discount: 0 },
        paymentAttempt: { id: 1042, attemptId: "checkout-attempt", Status: "Created" },
      }),
      clearCart: jest.fn().mockResolvedValue(undefined),
    };
    registerService("api::cart.cart", cartService);

  mockEntityFindOne(strapi, {
    "api::shipping.shipping": () => ({ id: 4, Title: "Pickup" }),
    "api::local-user-address.local-user-address": () => ({
      id: 18,
      shipping_city: {},
      user: { id: 1 },
    }),
    });

    const ctx = createCtx({
      request: {
        body: {
          shipping: 4,
          addressId: 18,
          gateway: "wallet",
          shippingCost: 0,
          mobile: "09120000000",
        },
      },
    });

    const handler = finalizeToOrderHandler(strapi);
    const response = await handler(ctx);

    expect(response.data).toMatchObject({
      success: true,
      message: "Order paid via wallet.",
      orderId: 42,
      contractId: 7,
      requestId: "wallet-order-42-checkout-attempt",
    });

    expect(cartService.finalizeCartToOrder).toHaveBeenCalledWith(
      ctx.state.user.id,
      expect.objectContaining({
        shippingId: 4,
        addressId: 18,
      }),
    );

    expect(mockedSettleOrderWithWallet).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        userId: 1,
        orderId: 42,
        contractId: 7,
        paymentAttemptId: 1042,
        attemptId: "checkout-attempt",
        totalToman: 250_000,
      }),
    );
    // Order-scoped, not the whole live cart: anything the customer added after this
    // checkout was created must survive settlement.
    expect(consumeCheckoutCartLinesSafely).toHaveBeenCalledWith(
      strapi,
      42,
      expect.objectContaining({ gateway: "Wallet" }),
    );
    expect(cartService.clearCart).not.toHaveBeenCalled();
  });

  it("fails fast when wallet balance is insufficient", async () => {
    const { strapi, registerService } = createStrapiMock();
    registerService("api::cart.cart", {
      finalizeCartToOrder: jest.fn().mockResolvedValue({
        success: true,
        order: { id: 10 },
        contract: { id: 20, Amount: 100_000 },
        financialSummary: { total: 100_000, payable: 100_000, discount: 0 },
        paymentAttempt: { id: 1010, attemptId: "checkout-attempt", Status: "Created" },
      }),
    });
    mockedSettleOrderWithWallet.mockRejectedValueOnce(
      new Error("WALLET_DEBIT_FAILED:Wallet balance is insufficient"),
    );
    mockEntityFindOne(strapi, {
      "api::shipping.shipping": () => ({ id: 1 }),
      "api::local-user-address.local-user-address": () => ({ id: 2, shipping_city: {}, user: { id: 1 } }),
    });

    const ctx = createCtx({
      request: {
        body: {
          shipping: 1,
          addressId: 2,
          gateway: "wallet",
        },
      },
    });

    const handler = finalizeToOrderHandler(strapi);
    await expect(handler(ctx)).rejects.toMatchObject({
      message: "WALLET_DEBIT_FAILED:Wallet balance is insufficient",
    });

    expect(ctx.badRequest).toHaveBeenNthCalledWith(
      1,
      "موجودی کیف پول کافی نیست یا پرداخت کامل نشد",
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: "WALLET_DEBIT_FAILED",
          attemptId: "checkout-attempt",
        }),
      }),
    );
    expect(mockedCancelOrderAndRelease).toHaveBeenCalledWith(
      strapi,
      10,
      20,
      1,
      "wallet_payment_failed",
      { createAuditLogs: true },
    );
  });

  it("propagates stock issues reported by finalizeCartToOrder", async () => {
    const { strapi, registerService } = createStrapiMock();
    registerService("api::cart.cart", {
      finalizeCartToOrder: jest.fn().mockResolvedValue({
        success: false,
        message: "Stock issues prevent order creation",
        itemsRemoved: [{ id: 1 }],
      }),
    });
  mockEntityFindOne(strapi, {
    "api::shipping.shipping": () => ({ id: 2 }),
    "api::local-user-address.local-user-address": () => ({ id: 3, shipping_city: {}, user: { id: 1 } }),
  });

    const ctx = createCtx({
      request: {
        body: {
          shipping: 2,
          addressId: 3,
          gateway: "mellat",
        },
      },
    });

    const handler = finalizeToOrderHandler(strapi);
    await expect(handler(ctx)).rejects.toMatchObject({
      message: "Stock issues prevent order creation",
    });

    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Stock issues prevent order creation",
      expect.objectContaining({
        data: expect.objectContaining({
          success: false,
          itemsRemoved: [{ id: 1 }],
        }),
      }),
    );
  });

  it("cancels the order when the external gateway rejects the payment outright", async () => {
    const { strapi, registerService } = createStrapiMock();
    const cartService = {
      finalizeCartToOrder: jest.fn().mockResolvedValue({
        success: true,
        order: { id: 501 },
        contract: { id: 77, Amount: 180_000 },
        financialSummary: { payable: 180_000 },
        paymentAttempt: { id: 1501, attemptId: "checkout-attempt", Status: "Created" },
      }),
    };
    registerService("api::cart.cart", cartService);

  mockEntityFindOne(strapi, {
    "api::shipping.shipping": () => ({ id: 4 }),
    "api::local-user-address.local-user-address": () => ({
      id: 22,
      shipping_city: {},
      user: { id: 9 },
    }),
  });

    // `resCode` is the bank's own verdict: it answered, and it said no. That is
    // proof no payment exists, so the order may be cancelled and the customer's
    // stock and wallet credit released immediately.
    mockedRequestMellatPayment.mockResolvedValue({
      success: false,
      error: "Gateway down",
      requestId: "REQ-123",
      resCode: 34,
      detailedError: { code: "XX" },
    });

    const ctx = createCtx({
      request: {
        body: {
          shipping: 4,
          addressId: 22,
          gateway: "mellat",
          shippingCost: 0,
        },
      },
      state: { user: { id: 9 } },
    });

    const handler = finalizeToOrderHandler(strapi);

    await expect(handler(ctx)).rejects.toMatchObject({
      message: "Gateway down",
      status: 400,
    });

    expect(mockedRequestMellatPayment).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        orderId: 501,
        amount: 180_000,
        userId: 9,
        contractId: 77,
        callbackURL: undefined,
      }),
    );

    expect(strapi.entityService.create).toHaveBeenCalledWith(
      "api::order-log.order-log",
      expect.objectContaining({
        data: expect.objectContaining({
          Description: expect.stringContaining("Gateway payment request failed"),
          Changes: expect.objectContaining({ requestId: "REQ-123" }),
        }),
      }),
    );

    expect(mockedCancelOrderAndRelease).toHaveBeenCalledWith(
      strapi,
      501,
      77,
      9,
      "payment_gateway_failure",
      { createAuditLogs: true },
    );

    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Gateway down",
      expect.objectContaining({
        data: expect.objectContaining({
          error: "Gateway down",
          requestId: "REQ-123",
        }),
      }),
    );
  });

  it("keeps the order intact when the gateway never answered", async () => {
    const { strapi, registerService } = createStrapiMock();
    registerService("api::cart.cart", {
      finalizeCartToOrder: jest.fn().mockResolvedValue({
        success: true,
        order: { id: 502 },
        contract: { id: 78, Amount: 180_000 },
        financialSummary: { payable: 180_000 },
        paymentAttempt: { id: 1502, attemptId: "checkout-attempt", Status: "Created" },
      }),
    });
    mockEntityFindOne(strapi, {
      "api::shipping.shipping": () => ({ id: 4 }),
      "api::local-user-address.local-user-address": () => ({
        id: 22,
        shipping_city: {},
        user: { id: 9 },
      }),
    });

    // A socket-level failure with no provider verdict. A payment may or may not
    // exist at the bank, so cancelling the order — and with it releasing the
    // stock and any wallet hold — would be acting on evidence we do not have.
    mockedRequestMellatPayment.mockResolvedValue({
      success: false,
      error: "socket hang up",
      requestId: "REQ-124",
      errorCode: "ECONNRESET",
    });

    const ctx = createCtx({
      request: {
        body: { shipping: 4, addressId: 22, gateway: "mellat", shippingCost: 0 },
      },
      state: { user: { id: 9 } },
    });

    const response: any = await finalizeToOrderHandler(strapi)(ctx);

    expect(ctx.status).toBe(202);
    expect(response.data).toMatchObject({
      success: false,
      errorCode: "PAYMENT_UNKNOWN",
      paymentStatus: "Unknown",
      orderId: 502,
    });
    expect(mockedCancelOrderAndRelease).not.toHaveBeenCalled();
    expect(mockedUpdatePaymentAttempt).toHaveBeenCalledWith(
      strapi,
      1502,
      expect.objectContaining({ Status: "Unknown", nextAction: "manual_review" }),
    );
  });

  it("returns redirect information when Mellat payment request succeeds", async () => {
    const { strapi, registerService } = createStrapiMock();
    const cartService = {
      finalizeCartToOrder: jest.fn().mockResolvedValue({
        success: true,
        order: { id: 88 },
        contract: { id: 44, Amount: 320_000 },
        financialSummary: { payable: 320_000 },
        paymentAttempt: { id: 1088, attemptId: "checkout-attempt", Status: "Created" },
      }),
    };
    registerService("api::cart.cart", cartService);

  mockEntityFindOne(strapi, {
    "api::shipping.shipping": () => ({ id: 4 }),
    "api::local-user-address.local-user-address": () => ({
      id: 12,
      shipping_city: {},
      user: { id: 1 },
    }),
  });

    mockedRequestMellatPayment.mockResolvedValue({
      success: true,
      redirectUrl: "https://bank.example/start/ABC",
      refId: "REF-1",
      requestId: "REQ-success",
    });

    const ctx = createCtx({
      request: {
        body: {
          shipping: 4,
          addressId: 12,
          gateway: "mellat",
          shippingCost: 0,
          callbackURL: "/custom/callback",
        },
      },
    });

    const handler = finalizeToOrderHandler(strapi);
    const response = await handler(ctx);

    expect(response.data).toMatchObject({
      success: true,
      message:
        "Order created successfully. Redirecting to payment gateway.",
      orderId: 88,
      contractId: 44,
      redirectUrl: "https://bank.example/start/ABC",
      refId: "REF-1",
      requestId: "REQ-success",
    });

    expect(mockedRequestMellatPayment).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        callbackURL: "/custom/callback",
      }),
    );

    expect(strapi.entityService.create).toHaveBeenCalledWith(
      "api::order-log.order-log",
      expect.objectContaining({
        data: expect.objectContaining({
          Description: expect.stringContaining("Gateway payment request initiated"),
          Changes: expect.objectContaining({
            hasRedirectUrl: true,
            hasProviderReference: true,
            requestId: "REQ-success",
          }),
        }),
      }),
    );

    expect(ctx.badRequest).not.toHaveBeenCalled();
  });

  it("returns redirect information when Saman payment request succeeds", async () => {
    const { strapi, registerService } = createStrapiMock();
    registerService("api::cart.cart", {
      finalizeCartToOrder: jest.fn().mockResolvedValue({
        success: true,
        order: { id: 91 },
        contract: { id: 55, Amount: 220_000 },
        financialSummary: { payable: 220_000 },
        paymentAttempt: { id: 1091, attemptId: "checkout-attempt", Status: "Created" },
      }),
    });

  mockEntityFindOne(strapi, {
    "api::shipping.shipping": () => ({ id: 3 }),
    "api::local-user-address.local-user-address": () => ({
      id: 9,
      shipping_city: {},
      user: { id: 1 },
    }),
  });

    mockedRequestSamanPayment.mockResolvedValue({
      paymentResult: {
        success: true,
        redirectUrl: "https://saman.example/start",
        refId: "SAM-REF",
        redirectMethod: "POST",
        formFields: { Token: "SAM-REF" },
        requestId: "SAM-REQUEST",
        resNum: "SAM-RES",
      },
    });

    const ctx = createCtx({
      request: {
        body: {
          shipping: 3,
          addressId: 9,
          gateway: "samankish",
          mobile: "09121234567",
        },
      },
    });

    const handler = finalizeToOrderHandler(strapi);
    const response = await handler(ctx);

    expect(response.data).toMatchObject({
      success: true,
      orderId: 91,
      contractId: 55,
      redirectUrl: "https://saman.example/start",
      refId: "SAM-REF",
      redirectMethod: "POST",
      formFields: { Token: "SAM-REF" },
      requestId: "SAM-REQUEST",
    });

    expect(mockedRequestSamanPayment).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        order: { id: 91 },
        contract: { id: 55, Amount: 220_000 },
        financialSummary: { payable: 220_000 },
        callbackURL: undefined,
        userId: ctx.state.user.id,
        cellNumber: "09121234567",
      }),
    );
    expect(mockedRequestMellatPayment).not.toHaveBeenCalled();
  });

  it("does not initiate an external provider twice for the same checkout attempt", async () => {
    const { strapi, registerService } = createStrapiMock();
    registerService("api::cart.cart", {
      finalizeCartToOrder: jest.fn().mockResolvedValue({
        success: true,
        replayed: true,
        order: { id: 92 },
        contract: { id: 56, Amount: 220_000 },
        financialSummary: { total: 220_000 },
        paymentAttempt: { id: 1092, attemptId: "checkout-attempt", Status: "Created" },
      }),
    });
    mockEntityFindOne(strapi, {
      "api::shipping.shipping": () => ({ id: 3 }),
      "api::local-user-address.local-user-address": () => ({
        id: 9,
        shipping_city: {},
        user: { id: 1 },
      }),
    });
    mockedClaimPaymentAttempt.mockResolvedValueOnce(false);
    mockedFindPaymentAttempt.mockResolvedValue({
      id: 1092,
      attemptId: "checkout-attempt",
      Status: "Pending",
      Gateway: "mellat",
    } as never);
    const ctx = createCtx({
      request: { body: { shipping: 3, addressId: 9, gateway: "mellat" } },
    });

    const response = await finalizeToOrderHandler(strapi)(ctx);

    expect(response.data).toEqual(expect.objectContaining({
      success: false,
      paymentStatus: "Pending",
      errorCode: "PAYMENT_IN_PROGRESS",
    }));
    expect(mockedRequestMellatPayment).not.toHaveBeenCalled();
  });

  it("initiates SnappPay through the hardened orchestrator", async () => {
    const { strapi, registerService } = createStrapiMock();
    const initiate = jest.fn().mockResolvedValue({
      success: true,
      status: "Redirected",
      redirectUrl: "https://snapp.test",
      transactionId: "ABC1234567",
    });
    const finalizeCartToOrder = jest.fn().mockResolvedValue({
      success: true,
      order: { id: 60 },
      contract: { id: 70, Amount: 200_000 },
      financialSummary: { payable: 200_000 },
      paymentAttempt: {
        id: 1060,
        attemptId: "checkout-attempt",
        Status: "Created",
      },
      snappayCallbackNonce: "abcdefghijklmnopqrstuv",
    });
    registerService("api::cart.cart", {
      finalizeCartToOrder,
    });
    registerService("api::payment-gateway.snappay-orchestrator", {
      initiate,
    });

  mockEntityFindOne(strapi, {
    "api::shipping.shipping": () => ({ id: 5 }),
    "api::local-user-address.local-user-address": () => ({
      id: 6,
      shipping_city: {},
      user: { id: 1 },
    }),
  });

    const ctx = createCtx({
      request: {
        body: {
          shipping: 5,
          addressId: 6,
          gateway: "snappay",
        },
      },
    });

    const handler = finalizeToOrderHandler(strapi);
    const response = await handler(ctx);

    expect(response.data).toEqual(
      expect.objectContaining({
        success: true,
        orderId: 60,
        contractId: 70,
        redirectUrl: "https://snapp.test",
        refId: "ABC1234567",
        requestId: "ABC1234567",
        attemptId: "checkout-attempt",
        paymentStatus: "Redirected",
      }),
    );
    expect(initiate).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentAttemptId: 1060,
        callbackNonce: "abcdefghijklmnopqrstuv",
      }),
    );
    const snappCheckoutData = finalizeCartToOrder.mock.calls[0][1];
    expect(snappCheckoutData).toEqual(
      expect.objectContaining({
        gateway: "snappay",
        attemptId: "checkout-attempt",
        quoteHash: "checkout-quote",
      }),
    );
    expect(mockedClaimPaymentAttempt).toHaveBeenCalledWith(strapi, 1060);
    const successLog = (strapi.log.info as jest.Mock).mock.calls.find(
      ([message]) => String(message).includes("Payment successful"),
    );
    expect(successLog?.[1]).toEqual(
      expect.objectContaining({
        hasRedirectUrl: true,
        hasProviderReference: true,
      }),
    );
    expect(successLog?.[1]).not.toHaveProperty("redirectUrl");
    expect(mockedUpdatePaymentAttempt).not.toHaveBeenCalled();
    const auditLog = (strapi.entityService.create as jest.Mock).mock.calls.find(
      ([uid, payload]) =>
        uid === "api::order-log.order-log" &&
        String(payload?.data?.Description || "").includes(
          "Gateway payment request initiated",
        ),
    );
    expect(auditLog?.[1]?.data?.Changes).not.toHaveProperty("redirectUrl");
    expect(auditLog?.[1]?.data?.Changes).toEqual(
      expect.objectContaining({ hasRedirectUrl: true }),
    );
  });

  it("resumes an uninitiated SnappPay replay with the stored callback nonce", async () => {
    const { strapi, registerService } = createStrapiMock();
    const callbackNonce = "abcdefghijklmnopqrstuv";
    const initiate = jest.fn().mockResolvedValue({
      success: true,
      status: "Redirected",
      redirectUrl: "https://snapp.test/recovered",
      transactionId: "RECOV12345",
    });
    registerService("api::cart.cart", {
      finalizeCartToOrder: jest.fn().mockResolvedValue({
        success: true,
        replayed: true,
        order: { id: 61 },
        contract: { id: 71, Amount: 200_000 },
        financialSummary: { payable: 200_000 },
        paymentAttempt: {
          id: 1061,
          attemptId: "checkout-attempt",
          Status: "Created",
          callbackNonce,
        },
      }),
    });
    registerService("api::payment-gateway.snappay-orchestrator", {
      initiate,
    });
    mockEntityFindOne(strapi, {
      "api::shipping.shipping": () => ({ id: 5 }),
      "api::local-user-address.local-user-address": () => ({
        id: 6,
        shipping_city: {},
        user: { id: 1 },
      }),
    });

    const response = await finalizeToOrderHandler(strapi)(
      createCtx({
        request: {
          body: {
            shipping: 5,
            addressId: 6,
            gateway: "snappay",
          },
        },
      }),
    );

    expect(initiate).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentAttemptId: 1061,
        callbackNonce,
      }),
    );
    expect(response.data).toEqual(
      expect.objectContaining({
        success: true,
        redirectUrl: "https://snapp.test/recovered",
        paymentStatus: "Redirected",
      }),
    );
  });

  it("asks SnappPay status via initiate instead of replaying a Redirected URL", async () => {
    const { strapi, registerService } = createStrapiMock();
    const callbackNonce = "abcdefghijklmnopqrstuv";
    const initiate = jest.fn().mockResolvedValue({
      success: true,
      status: "Redirected",
      redirectUrl: "https://snapp.test/status-first",
      transactionId: "NEW1234567",
    });
    registerService("api::cart.cart", {
      finalizeCartToOrder: jest.fn().mockResolvedValue({
        success: true,
        replayed: true,
        order: { id: 61 },
        contract: { id: 71, Amount: 200_000 },
        financialSummary: { payable: 200_000 },
        paymentAttempt: {
          id: 1061,
          attemptId: "checkout-attempt",
          Status: "Redirected",
          callbackNonce,
          redirectUrl: "https://snapp.test/stale",
        },
      }),
    });
    registerService("api::payment-gateway.snappay-orchestrator", {
      initiate,
    });
    mockEntityFindOne(strapi, {
      "api::shipping.shipping": () => ({ id: 5 }),
      "api::local-user-address.local-user-address": () => ({
        id: 6,
        shipping_city: {},
        user: { id: 1 },
      }),
    });
    mockedClaimPaymentAttempt.mockResolvedValueOnce(false);

    const response = await finalizeToOrderHandler(strapi)(
      createCtx({
        request: {
          body: {
            shipping: 5,
            addressId: 6,
            gateway: "snappay",
          },
        },
      }),
    );

    expect(initiate).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentAttemptId: 1061,
        callbackNonce,
      }),
    );
    expect(response.data).toEqual(
      expect.objectContaining({
        success: true,
        redirectUrl: "https://snapp.test/status-first",
        paymentStatus: "Redirected",
      }),
    );
  });

  it("fails closed when an uninitiated SnappPay replay nonce cannot be decrypted", async () => {
    const { strapi, registerService } = createStrapiMock();
    const initiate = jest.fn();
    registerService("api::cart.cart", {
      finalizeCartToOrder: jest.fn().mockResolvedValue({
        success: true,
        replayed: true,
        order: { id: 62 },
        contract: { id: 72, Amount: 200_000 },
        financialSummary: { payable: 200_000 },
        paymentAttempt: {
          id: 1062,
          attemptId: "checkout-attempt",
          Status: "Created",
          callbackNonce: "",
        },
      }),
    });
    registerService("api::payment-gateway.snappay-orchestrator", {
      initiate,
    });
    mockEntityFindOne(strapi, {
      "api::shipping.shipping": () => ({ id: 5 }),
      "api::local-user-address.local-user-address": () => ({
        id: 6,
        shipping_city: {},
        user: { id: 1 },
      }),
    });
    const ctx = createCtx({
      request: {
        body: {
          shipping: 5,
          addressId: 6,
          gateway: "snappay",
        },
      },
    });

    const response = await finalizeToOrderHandler(strapi)(ctx);

    expect(initiate).not.toHaveBeenCalled();
    expect(mockedUpdatePaymentAttempt).toHaveBeenCalledWith(
      strapi,
      1062,
      expect.objectContaining({
        Status: "Unknown",
        failureCode: "SNAPPAY_CALLBACK_NONCE_UNRECOVERABLE",
        nextAction: "manual_review",
      }),
    );
    expect(ctx.status).toBe(202);
    expect(response.data).toEqual(
      expect.objectContaining({
        success: false,
        paymentStatus: "Unknown",
      }),
    );
  });
});
