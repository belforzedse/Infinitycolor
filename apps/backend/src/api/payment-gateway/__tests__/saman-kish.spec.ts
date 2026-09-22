const mockPost = jest.fn();

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: mockPost },
}));

import samanKishFactory from "../services/saman-kish";

const originalEnv = process.env;

describe("Saman Kish service", () => {
  const strapi: any = {
    log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      SAMAN_TERMINAL_ID: "123456",
      SAMAN_GATEWAY_URL: "https://sep.shaparak.ir/onlinepg/OnlinePG",
      SAMAN_PAYMENT_PAGE_URL: "https://sep.shaparak.ir/OnlinePG/OnlinePG",
      SAMAN_CALLBACK_URL: "https://api.example.test/api/orders/payment-callback",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("requests a token then returns SEP's POST handoff contract", async () => {
    mockPost.mockResolvedValue({ data: { status: "1", Token: "SEP-TOKEN-1" } });
    const service: any = samanKishFactory({ strapi });

    const result = await service.requestPayment({
      orderId: 42,
      amount: 1_000_000,
      resNum: "wallet-42",
      callbackURL: "https://api.example.test/api/wallet/payment-callback",
    });

    expect(mockPost).toHaveBeenCalledWith(
      "https://sep.shaparak.ir/onlinepg/OnlinePG",
      expect.objectContaining({
        Action: "Token",
        TerminalId: "123456",
        Amount: 1_000_000,
        ResNum: "wallet-42",
        RedirectUrl: "https://api.example.test/api/wallet/payment-callback",
      }),
      expect.any(Object),
    );
    expect(result).toMatchObject({
      success: true,
      token: "SEP-TOKEN-1",
      redirectUrl: "https://sep.shaparak.ir/OnlinePG/OnlinePG",
      redirectMethod: "POST",
      formFields: { Token: "SEP-TOKEN-1" },
    });
    expect(result.redirectUrl).not.toContain("SEP-TOKEN-1");
    expect(result.redirectUrl).not.toContain("SendToken");
  });
});
