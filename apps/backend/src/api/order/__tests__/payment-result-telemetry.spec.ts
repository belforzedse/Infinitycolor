import * as Sentry from "@sentry/node";
import {
  buildPaymentResultRedirectUrl,
  isExpectedProviderCallbackFailure,
  verifyPaymentHandler,
} from "../controllers/helpers/payment";
jest.mock("@sentry/node", () => ({
  logger: { info: jest.fn() },
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

describe("payment redirect telemetry", () => {
  const original = process.env.SENTRY_EXPECTED_EVENTS_TO_LOGS;
  beforeEach(() => {
    process.env.SENTRY_EXPECTED_EVENTS_TO_LOGS = "true";
    jest.clearAllMocks();
  });
  afterAll(() => {
    process.env.SENTRY_EXPECTED_EVENTS_TO_LOGS = original;
  });
  it("keeps the pending redirect identical while moving the expected observation into Logs", () => {
    const url = new URL(
      buildPaymentResultRedirectUrl("issue", { orderId: 123, code: "return_without_result" }),
    );
    expect(url.pathname).toBe("/payment/result");
    expect(url.searchParams.get("resultHint")).toBe("issue");
    expect(url.searchParams.get("orderId")).toBe("123");
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.logger.info).toHaveBeenCalledWith(
      "payment.result:issue",
      expect.objectContaining({ reasonCode: "return_without_result" }),
    );
  });
  it.each([
    "zarinpal_verification_ambiguous",
    "mellat_local_settlement_failed",
    "amount_mismatch_reversal_unknown",
  ])("keeps actionable %s in Issues", (code) => {
    buildPaymentResultRedirectUrl("issue", { orderId: 123, code });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "payment.result:issue",
      expect.objectContaining({ level: "error" }),
    );
    expect(Sentry.logger.info).not.toHaveBeenCalled();
  });
  it("retains failure reports unless the caller proves an ordinary decline", () => {
    buildPaymentResultRedirectUrl("failure", { orderId: 123, error: "Settlement failed" });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    buildPaymentResultRedirectUrl("failure", { orderId: 123, error: "Provider declined" }, true);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.logger.info).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["mellat", "12", true],
    ["mellat", "17", true],
    ["mellat", "21", false],
    ["mellat", "34", false],
    ["mellat", "unknown", false],
    ["saman", "FAILED", true],
    ["saman", "CANCELEDBYUSER", true],
    ["saman", "SESSIONISNULL", true],
    ["saman", "INVALIDPARAMETERS", false],
    ["saman", "TERMINALNOTFOUND", false],
    ["saman", "unknown", false],
  ] as const)("classifies only known %s callback outcomes: %s", (gateway, code, expected) => {
    const classified = isExpectedProviderCallbackFailure(gateway, code);
    expect(classified).toBe(expected);
    buildPaymentResultRedirectUrl("failure", { orderId: 123, code }, classified);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(expected ? 0 : 1);
    expect(Sentry.logger.info).toHaveBeenCalledTimes(expected ? 1 : 0);
  });
});

it("reports a failed nonce reconciliation while still redirecting the shopper", async () => {
  const failure = new Error("test provider unavailable");
  const strapi: any = {
    db: { query: () => ({ findOne: jest.fn().mockResolvedValue({ order: { id: 123 } }) }) },
    service: () => ({ reconcileOrder: jest.fn().mockRejectedValue(failure) }),
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
  const ctx = {
    request: { method: "GET", body: {}, query: { nonce: "abcdefghijklmnopqrstuv" } },
    redirect: jest.fn(),
  };
  await verifyPaymentHandler(strapi, ctx);
  expect(Sentry.captureException).toHaveBeenCalledWith(
    failure,
    expect.objectContaining({
      tags: expect.objectContaining({ reasonCode: "return_reconciliation_failed" }),
    }),
  );
  expect(ctx.redirect).toHaveBeenCalledWith(expect.stringContaining("orderId=123"));
});
