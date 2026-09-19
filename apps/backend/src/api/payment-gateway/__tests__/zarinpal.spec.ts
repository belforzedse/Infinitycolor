const mockRequest = jest.fn();
const mockGetRedirectUrl = jest.fn((authority: string) => `https://zarinpal.test/pay/${authority}`);
const mockVerify = jest.fn();

jest.mock("zarinpal-node-sdk", () =>
  jest.fn().mockImplementation(() => ({
    request: mockRequest,
    payments: {
      getRedirectUrl: mockGetRedirectUrl,
    },
    verifications: {
      verify: mockVerify,
    },
  })),
);

import zarinpalServiceFactory from "../services/zarinpal";

const originalEnv = process.env;

const createService = () => {
  const strapi = {
    log: {
      info: jest.fn(),
      error: jest.fn(),
    },
  };

  return {
    strapi,
    service: zarinpalServiceFactory({ strapi: strapi as any }) as any,
  };
};

describe("ZarinPal payment gateway service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ZARINPAL_CALLBACK_URL;
    delete process.env.ZARINPAL_CURRENCY;
    delete process.env.ZARINPAL_E2E_DETERMINISTIC;
    delete process.env.ZARINPAL_MERCHANT_ID;
    delete process.env.ZARINPAL_SANDBOX;
    delete process.env.URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("does not simulate merely because the callback URL is local", () => {
    process.env.URL = "http://localhost:1337";
    delete process.env.ZARINPAL_MERCHANT_ID;
    const { service } = createService();

    // Without an explicit opt-in there is no merchant id to fall back on, so the
    // service refuses rather than quietly accepting fabricated receipts.
    expect(() => service.getConfig()).toThrow(/merchant ID is not configured/i);
  });

  it("uses deterministic sandbox config only when explicitly enabled", () => {
    process.env.URL = "http://localhost:1337";
    process.env.ZARINPAL_E2E_DETERMINISTIC = "1";
    const { service } = createService();

    expect(service.getConfig()).toEqual({
      merchantId: "00000000-0000-0000-0000-000000000000",
      sandbox: true,
      callbackUrl: "http://localhost:1337/api/orders/payment-callback",
      currency: "IRR",
    });
  });

  it("accepts a purpose-specific callback URL for wallet top-ups", () => {
    process.env.URL = "http://localhost:1337";
    process.env.ZARINPAL_E2E_DETERMINISTIC = "1";
    const { service } = createService();

    expect(service.getConfig("https://api.example.test/api/wallet/payment-callback")).toMatchObject(
      { callbackUrl: "https://api.example.test/api/wallet/payment-callback" },
    );
  });

  it("refuses deterministic mode outright in a production build", () => {
    process.env.URL = "http://localhost:1337";
    process.env.ZARINPAL_E2E_DETERMINISTIC = "1";
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { service } = createService();
      expect(() => service.getConfig()).toThrow(/ZARINPAL_SIMULATION_REFUSED/);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("converts gateway amounts for IRR and IRT currencies", () => {
    process.env.URL = "http://localhost:1337";
    const { service } = createService();

    expect(service.amountForGateway(1234.4, "IRR")).toBe(12340);
    expect(service.amountForGateway(1234.4, "IRT")).toBe(1234);
  });

  it("rejects amounts below ZarinPal minimums", () => {
    const { service } = createService();

    expect(() => service.assertValidAmount(9_999, "IRR")).toThrow(
      "ZarinPal amount must be at least 10000 IRR",
    );
    expect(() => service.assertValidAmount(999, "IRT")).toThrow(
      "ZarinPal amount must be at least 1000 IRT",
    );
  });

  it("returns a deterministic redirect without making a gateway request when simulation is on", async () => {
    process.env.URL = "http://localhost:1337";
    process.env.ZARINPAL_E2E_DETERMINISTIC = "1";
    const { service } = createService();

    const result = await service.requestPayment({
      orderId: 42,
      amountToman: 25_000,
      mobile: "+989121234567",
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        authority: expect.stringContaining("E2E-42-"),
        redirectUrl: expect.stringContaining("https://zarinpal.test/pay/E2E-42-"),
        amount: 250_000,
        currency: "IRR",
      }),
    );
    expect(mockGetRedirectUrl).toHaveBeenCalledWith(result.authority);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("maps a successful gateway request and strips merchant id from stored response", async () => {
    process.env.URL = "https://api.infinitycolor.co";
    process.env.ZARINPAL_MERCHANT_ID = "merchant-123";
    mockRequest.mockResolvedValue({
      data: { code: 100, authority: "AUTH-1" },
      merchant_id: "merchant-123",
    });
    const { service } = createService();

    const result = await service.requestPayment({
      orderId: 7,
      amountToman: 5_000,
      email: "buyer@example.test",
      mobile: "9121234567",
      description: "Order payment",
    });

    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/pg/v4/payment/request.json",
      expect.objectContaining({
        merchant_id: "merchant-123",
        amount: 50_000,
        callback_url: "https://api.infinitycolor.co/api/orders/payment-callback",
        metadata: {
          order_id: "7",
          mobile: "09121234567",
          email: "buyer@example.test",
        },
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        authority: "AUTH-1",
        refId: "AUTH-1",
        redirectUrl: "https://zarinpal.test/pay/AUTH-1",
      }),
    );
    expect(result.gatewayResponse).not.toHaveProperty("merchant_id");
  });

  it("sanitizes gateway error details without throwing", async () => {
    process.env.URL = "https://api.infinitycolor.co";
    process.env.ZARINPAL_MERCHANT_ID = "merchant-123";
    mockRequest.mockRejectedValue({
      message: "gateway unavailable",
      response: {
        status: 502,
        data: {
          merchant_id: "merchant-123",
          errors: [{ code: -9 }],
        },
      },
    });
    const { service } = createService();

    const result = await service.requestPayment({
      orderId: 8,
      amountToman: 5_000,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: "gateway unavailable",
        detailedError: expect.objectContaining({
          status: 502,
          data: { errors: [{ code: -9 }] },
        }),
      }),
    );
    expect(result.detailedError.data).not.toHaveProperty("merchant_id");
  });

  it("maps successful, already-verified, and failed verification responses", async () => {
    process.env.URL = "https://api.infinitycolor.co";
    process.env.ZARINPAL_MERCHANT_ID = "merchant-123";
    const { service } = createService();

    mockVerify.mockResolvedValueOnce({
      data: { code: 100, ref_id: 123, card_pan: "6219", fee: 200 },
    });
    await expect(
      service.verifyPayment({ authority: "AUTH-OK", amountToman: 10_000 }),
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        alreadyVerified: false,
        code: 100,
        refId: "123",
        amount: 100_000,
      }),
    );

    mockVerify.mockResolvedValueOnce({
      data: { code: 101, ref_id: 123, message: "already verified" },
    });
    await expect(
      service.verifyPayment({ authority: "AUTH-DUP", amountToman: 10_000 }),
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        alreadyVerified: true,
        code: 101,
        message: "already verified",
      }),
    );

    mockVerify.mockRejectedValueOnce({
      message: "verification failed",
      response: { data: { data: { code: -51 }, merchant_id: "merchant-123" } },
    });
    await expect(
      service.verifyPayment({ authority: "AUTH-FAIL", amountToman: 10_000 }),
    ).resolves.toEqual(
      expect.objectContaining({
        success: false,
        code: -51,
        error: "verification failed",
        gatewayResponse: { data: { code: -51 } },
      }),
    );
  });

  it.each([
    ["network failure", { message: "socket timeout" }],
    ["provider outage", { message: "upstream unavailable", response: { status: 503 } }],
    ["provider throttling", { message: "retry later", response: { status: 429 } }],
  ])("marks %s during verification as ambiguous", async (_label, gatewayError) => {
    process.env.URL = "https://api.infinitycolor.co";
    process.env.ZARINPAL_MERCHANT_ID = "merchant-123";
    mockVerify.mockRejectedValueOnce(gatewayError);
    const { service } = createService();

    await expect(
      service.verifyPayment({ authority: "AUTH-UNKNOWN", amountToman: 10_000 }),
    ).resolves.toEqual(
      expect.objectContaining({
        success: false,
        ambiguous: true,
      }),
    );
  });

  it("keeps a provider-declared 4xx verification rejection definitive", async () => {
    process.env.URL = "https://api.infinitycolor.co";
    process.env.ZARINPAL_MERCHANT_ID = "merchant-123";
    mockVerify.mockRejectedValueOnce({
      message: "Authority invalid",
      response: {
        status: 400,
        data: { data: { code: -51 } },
      },
    });
    const { service } = createService();

    await expect(
      service.verifyPayment({ authority: "AUTH-BAD", amountToman: 10_000 }),
    ).resolves.toEqual(
      expect.objectContaining({
        success: false,
        ambiguous: false,
        code: -51,
      }),
    );
  });
});
