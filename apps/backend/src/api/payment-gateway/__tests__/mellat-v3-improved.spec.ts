const mockInitialize = jest.fn();
const mockSoap = jest.fn();
const mockAbort = jest.fn();
const mockHttpRequest = jest.fn();
const mockHttpClient = { request: mockHttpRequest };

jest.mock("mellat-checkout", () => jest.fn().mockImplementation((config) => ({
  config,
  initialize: mockInitialize,
  client: {
    httpClient: mockHttpClient,
    bpPayRequest: mockSoap,
    bpVerifyRequest: mockSoap,
    bpSettleRequest: mockSoap,
    bpReversalRequest: mockSoap,
    bpInquiryRequest: mockSoap,
  },
})));

import createService from "../services/mellat-v3";

describe("Mellat SOAP deadlines and transport cancellation", () => {
  let service: ReturnType<typeof createService>;
  const payment = { orderId: "100", amount: 1000 };
  const tuple = { orderId: "100", saleOrderId: "100", saleReferenceId: "9007199254740993" };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    process.env.MELLAT_TERMINAL_ID = "1234567";
    process.env.MELLAT_USERNAME = "merchant";
    process.env.MELLAT_PASSWORD = "secret";
    process.env.URL = "https://api.store.test";
    mockHttpClient.request = mockHttpRequest;
    mockInitialize.mockResolvedValue(undefined);
    mockHttpRequest.mockReturnValue({ abort: mockAbort });
    // Mirror soap@0.23: generated bp* returns undefined, HTTP client owns the request.
    mockSoap.mockImplementation((_args, callback, options) => {
      mockHttpClient.request("https://gateway.test.invalid", "<SOAP/>", callback, {}, options);
    });
    service = createService({ strapi: { log: { warn: jest.fn() } } as any });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves an initialization hang after 15 seconds and never sends a payment", async () => {
    mockInitialize.mockImplementation(() => new Promise(() => {}));
    const result = service.requestPayment(payment);
    await jest.advanceTimersByTimeAsync(14999);
    expect(mockSoap).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ success: false, ambiguous: true, errorCode: "ETIMEDOUT" });
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockSoap).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(["requestPayment", "verifyTransaction", "settleTransaction", "reverseTransaction", "inquiryTransaction"])(
    "%s aborts a stalled transport at exactly 15 seconds without retries", async (method) => {
      const result = service[method](method === "requestPayment" ? payment : tuple);
      await jest.advanceTimersByTimeAsync(14999);
      expect(mockSoap).toHaveBeenCalledTimes(1);
      expect(mockHttpRequest.mock.calls[0][4]).toMatchObject({ timeout: 15000 });
      expect(mockAbort).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ success: false, ambiguous: true, errorCode: "ETIMEDOUT" });
      expect(mockAbort).toHaveBeenCalledTimes(1);
      expect(mockSoap).toHaveBeenCalledTimes(1);
      expect(mockHttpClient.request).toBe(mockHttpRequest);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it("ignores a late callback after timeout", async () => {
    let callback: (error: unknown, response: unknown) => void;
    mockSoap.mockImplementation((_args, suppliedCallback, options) => {
      callback = suppliedCallback;
      mockHttpClient.request("https://gateway.test.invalid", "<SOAP/>", suppliedCallback, {}, options);
    });
    const pending = service.requestPayment(payment);
    await jest.advanceTimersByTimeAsync(15000);
    const result = await pending;
    callback!(null, { return: "0,LateRefId" });
    expect(result).toMatchObject({ success: false, ambiguous: true, errorCode: "ETIMEDOUT" });
    expect(result.refId).toBeUndefined();
  });

  it("clears deadlines after a normal SOAP callback", async () => {
    mockSoap.mockImplementation((_args, callback) => callback(null, { return: "0,RefId" }));
    expect(await service.requestPayment(payment)).toMatchObject({ success: true, ambiguous: false });
    await jest.advanceTimersByTimeAsync(15000);
    expect(mockAbort).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(mockHttpClient.request).toBe(mockHttpRequest);
  });
});
