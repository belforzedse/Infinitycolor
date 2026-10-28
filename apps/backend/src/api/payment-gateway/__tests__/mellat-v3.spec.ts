const mockInitialize = jest.fn();
const mockPay = jest.fn();
const mockVerify = jest.fn();
const mockSettle = jest.fn();
const mockReverse = jest.fn();
const mockInquiry = jest.fn();
const mockPackagePaymentRequest = jest.fn();

jest.mock("mellat-checkout", () => jest.fn().mockImplementation((config) => ({
  config,
  initialize: mockInitialize,
  paymentRequest: mockPackagePaymentRequest,
  client: {
    bpPayRequest: mockPay,
    bpVerifyRequest: mockVerify,
    bpSettleRequest: mockSettle,
    bpReversalRequest: mockReverse,
    bpInquiryRequest: mockInquiry,
  },
})));

import MellatCheckout from "mellat-checkout";
import createService, { mellatTerminalFingerprint } from "../services/mellat-v3";

describe("Mellat v3 raw SOAP adapter", () => {
  let service: ReturnType<typeof createService>;
  let log: Record<string, jest.Mock>;
  const payment = { orderId: "9223372036854775807", amount: 12345, userId: 12 };
  const tuple = {
    orderId: "9223372036854775807",
    saleOrderId: "9223372036854775807",
    saleReferenceId: "9007199254740993",
  };
  const reply = (mock: jest.Mock, value: unknown) => mock.mockImplementation(
    (_args, callback) => callback(null, value),
  );

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.MELLAT_TERMINAL_ID = "1234567";
    process.env.MELLAT_USERNAME = "merchant-user";
    process.env.MELLAT_PASSWORD = "never-log-this-password";
    process.env.MELLAT_GATEWAY_URL = "https://gateway.test.invalid/pgw";
    process.env.URL = "https://api.store.test/base?ignored=true";
    // resetAllMocks resets the mocked constructor too.
    (MellatCheckout as unknown as jest.Mock).mockImplementation((config) => ({
      config,
      initialize: mockInitialize,
      paymentRequest: mockPackagePaymentRequest,
      client: {
        bpPayRequest: mockPay, bpVerifyRequest: mockVerify, bpSettleRequest: mockSettle,
        bpReversalRequest: mockReverse, bpInquiryRequest: mockInquiry,
      },
    }));
    mockInitialize.mockResolvedValue(undefined);
    reply(mockPay, { return: "0,aBcDEF123" });
    for (const mock of [mockVerify, mockSettle, mockReverse, mockInquiry]) reply(mock, { return: "0" });
    log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    service = createService({ strapi: { log } as any });
  });

  it("initializes the package, calls raw SOAP once, and preserves long IDs and RefId case", async () => {
    const result = await service.requestPayment({ ...payment, includePayerId: true });

    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockPay).toHaveBeenCalledTimes(1);
    expect(mockPackagePaymentRequest).not.toHaveBeenCalled();
    expect(mockPay).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: "1234567", userName: "merchant-user", userPassword: "never-log-this-password",
      orderId: "9223372036854775807", amount: 123450, payerId: "12",
      callBackUrl: "https://api.store.test/api/orders/payment-callback",
      localDate: expect.stringMatching(/^\d{8}$/), localTime: expect.stringMatching(/^\d{6}$/),
    }), expect.any(Function), { timeout: 15000 });
    expect(result).toMatchObject({
      success: true, ambiguous: false, resCode: 0, rawResCode: "0", refId: "aBcDEF123",
      requestedAmountIrr: 123450, saleOrderId: "9223372036854775807",
      terminalFingerprint: mellatTerminalFingerprint(),
      redirectUrl: "https://bpm.shaparak.ir/pgwchannel/startpay.mellat",
      requestId: expect.stringMatching(/^REQ-\d+-[a-z0-9]+$/),
    });
  });

  it("sends an already-IRR amount without converting it again and defaults payerId to zero", async () => {
    await service.requestPayment({ ...payment, amountInRial: true });
    expect(mockPay.mock.calls[0][0]).toMatchObject({ amount: 12345, payerId: "0" });
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER])(
    "rejects invalid or overflowing toman amount %s before creating a client", async (amount) => {
      const result = await service.requestPayment({ ...payment, amount });
      expect(result).toMatchObject({ success: false, ambiguous: false, errorCode: "MELLAT_INVALID_AMOUNT" });
      expect(MellatCheckout).not.toHaveBeenCalled();
      expect(mockPay).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "-1", "1e9", " 1", "9223372036854775808", 9007199254740992])(
    "rejects invalid order ID %s before SOAP", async (orderId) => {
      expect(await service.requestPayment({ ...payment, orderId })).toMatchObject({
        success: false, ambiguous: false, errorCode: "MELLAT_INVALID_ID",
      });
      expect(mockPay).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://evil.test/callback", "//evil.test/path", "javascript:alert(1)",
    "https://api.store.test/api/wallet/payment-callback", "/api/wallet/payment-callback",
  ])("ignores callbackURL override %s", async (callbackURL) => {
    await service.requestPayment({ ...payment, callbackURL });
    expect(mockPay.mock.calls[0][0].callBackUrl).toBe("https://api.store.test/api/orders/payment-callback");
  });

  it("allows the internal wallet purpose while still deriving its URL from server configuration", async () => {
    await service.requestPayment({ ...payment, callbackPurpose: "wallet", callbackURL: "https://evil.test" });
    expect(mockPay.mock.calls[0][0].callBackUrl).toBe("https://api.store.test/api/wallet/payment-callback");
  });

  it("fails closed for an invalid server callback base", async () => {
    process.env.URL = "https://user:password@api.store.test";
    expect(await service.requestPayment(payment)).toMatchObject({
      success: false, ambiguous: false, errorCode: "MELLAT_CALLBACK_INVALID",
    });
    expect(mockPay).not.toHaveBeenCalled();
  });

  it("preserves a definite numeric provider rejection", async () => {
    reply(mockPay, { return: "62" });
    expect(await service.requestPayment(payment)).toMatchObject({
      success: false, ambiguous: false, resCode: 62, rawResCode: "62", error: "Gateway error: 62",
    });
  });

  it("preserves a comma-prefixed rejection code but rejects its malformed fields", async () => {
    reply(mockPay, { return: "62,DoNotTreatAsRefId" });
    const result = await service.requestPayment(payment);
    expect(result).toMatchObject({
      success: false, ambiguous: true, resCode: 62, rawResCode: "62", errorCode: "MELLAT_MALFORMED_RESPONSE",
    });
    expect(result.refId).toBeUndefined();
  });

  it.each([
    undefined, { RefId: "arbitrary" }, { return: 0 }, { return: "0" }, { return: "0," },
    { return: "0, " }, { return: "0,ref,extra" }, { return: "garbage,ref" },
    { return: "0,ref", extra: "unexpected" },
  ])("never accepts malformed payment response %j", async (response) => {
    reply(mockPay, response);
    expect(await service.requestPayment(payment)).toMatchObject({
      success: false, ambiguous: true, errorCode: "MELLAT_MALFORMED_RESPONSE",
    });
  });

  it("does not retry initiation on transport error or expose SOAP payloads", async () => {
    const error = Object.assign(new Error("SOAP body userPassword=never-log-this-password"), {
      code: "ECONNRESET", errno: -104, body: "sensitive SOAP",
    });
    mockPay.mockImplementation((_args, callback) => callback(error));
    const result = await service.requestPayment(payment);
    expect(mockPay).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, ambiguous: true, errorCode: "ECONNRESET", errorErrno: -104 });
    const exposed = JSON.stringify({ result, logs: Object.values(log).map((fn) => fn.mock.calls) });
    expect(exposed).not.toContain("never-log-this-password");
    expect(exposed).not.toContain("merchant-user");
    expect(exposed).not.toContain("sensitive SOAP");
  });

  it("stops before SOAP if initialization fails", async () => {
    mockInitialize.mockRejectedValue(new Error("sensitive WSDL fault"));
    expect(await service.requestPayment(payment)).toMatchObject({ success: false, ambiguous: true });
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockPay).not.toHaveBeenCalled();
  });

  it("configures a 15-second WSDL timeout and snapshots credentials per client", () => {
    const first = service.createMellatClient();
    process.env.MELLAT_USERNAME = "second-user";
    const second = service.createMellatClient();
    expect(first.config).toMatchObject({
      username: "merchant-user", timeout: 15000, apiUrl: "https://gateway.test.invalid/pgw?wsdl",
    });
    expect(second.config.username).toBe("second-user");
  });

  it("rejects missing credentials before initialization", async () => {
    delete process.env.MELLAT_PASSWORD;
    expect(await service.requestPayment(payment)).toMatchObject({
      success: false, ambiguous: false, errorCode: "MELLAT_CONFIG_INVALID",
    });
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it.each([
    ["verifyTransaction", mockVerify, "0", true], ["verifyTransaction", mockVerify, "43", true],
    ["verifyTransaction", mockVerify, "45", false],
    ["settleTransaction", mockSettle, "0", true], ["settleTransaction", mockSettle, "45", true],
    ["settleTransaction", mockSettle, "46", false],
    ["reverseTransaction", mockReverse, "0", true], ["reverseTransaction", mockReverse, "48", true],
    ["reverseTransaction", mockReverse, "45", false],
    ["inquiryTransaction", mockInquiry, "42", true], ["inquiryTransaction", mockInquiry, "46", true],
  ])("%s strictly preserves provider code %s", async (method, mock, code, success) => {
    reply(mock as jest.Mock, { return: code });
    const result = await service[method as string]({ ...tuple, requestedAmountIrr: 100000 });
    expect(result).toMatchObject({
      success, ambiguous: false, resCode: Number(code), rawResCode: code,
      saleOrderId: tuple.saleOrderId, requestedAmountIrr: 100000,
      terminalFingerprint: mellatTerminalFingerprint(),
    });
    expect(mock).toHaveBeenCalledWith(expect.objectContaining(tuple), expect.any(Function), { timeout: 15000 });
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it.each(["verifyTransaction", "settleTransaction", "reverseTransaction", "inquiryTransaction"])(
    "%s rejects malformed provider success", async (method) => {
      for (const mock of [mockVerify, mockSettle, mockReverse, mockInquiry]) reply(mock, { return: "0,unexpected" });
      expect(await service[method]({ ...tuple })).toMatchObject({
        success: false, ambiguous: true, resCode: 0, errorCode: "MELLAT_MALFORMED_RESPONSE",
      });
    },
  );

  it("validates the complete transaction tuple before sending anything", async () => {
    expect(await service.settleTransaction({ ...tuple, saleReferenceId: "not-a-long" })).toMatchObject({
      success: false, ambiguous: false, errorCode: "MELLAT_INVALID_ID",
    });
    expect(mockInitialize).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });
});
