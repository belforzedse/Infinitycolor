/**
 * A checkout attempt id can outlive the payment it started: the storefront never
 * cleared `pendingCheckoutAttemptId` from localStorage when a SnappPay attempt was
 * abandoned (back-navigation) or expired, so a retry with the same cart replayed a
 * dead attempt forever, each time returning its stale terminal state as the
 * finalize response and never letting the shopper start a fresh one. See
 * checkout.error:SNAPPAY_RECONCILIATION_PENDING.
 */
jest.mock("@strapi/strapi", () => ({
  factories: { createCoreService: (_uid: string, fn: any) => fn },
}));

jest.mock("../services/lib/get-user-cart", () => ({ getOrCreateUserCart: jest.fn() }));
jest.mock("../services/lib/order", () => ({ createOrderAndItems: jest.fn() }));
jest.mock("../services/lib/discounts", () => ({
  computeCouponDiscount: jest.fn(),
  findFirstActiveGeneralDiscount: jest.fn().mockResolvedValue([]),
}));
jest.mock("../services/lib/discount-claim", () => ({ claimLimitedDiscountUsage: jest.fn() }));
jest.mock("../services/lib/financials", () => ({ computeTotals: jest.fn() }));
jest.mock("../services/lib/contract", () => ({ createContract: jest.fn() }));
jest.mock("../services/lib/stock", () => ({ reserveStockAtomic: jest.fn() }));
jest.mock("../services/ops/addCartItem", () => ({ addCartItemOp: jest.fn() }));
jest.mock("../services/ops/updateCartItem", () => ({ updateCartItemOp: jest.fn() }));
jest.mock("../services/ops/removeCartItem", () => ({ removeCartItemOp: jest.fn() }));
jest.mock("../services/ops/checkCartStock", () => ({ checkCartStockOp: jest.fn() }));
jest.mock("../services/lib/checkout-quote", () => ({ createCheckoutQuote: jest.fn() }));
jest.mock("../../payment-attempt/services/payment-attempt", () => ({
  createPaymentAttempt: jest.fn(),
  findPaymentAttempt: jest.fn(),
}));
jest.mock("../../payment-gateway/services/snappay-security", () => ({
  generateSnappayCallbackNonce: jest.fn(),
  generateSnappayTransactionId: jest.fn(),
  hashSnappayCallbackNonce: jest.fn(),
}));

const { findPaymentAttempt } = require("../../payment-attempt/services/payment-attempt");
const createCartService = require("../services/cart").default;

const QUOTE_HASH = "quote-hash";

const buildService = () => {
  const strapi: any = {
    log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    db: { transaction: jest.fn() },
  };
  const service = createCartService({ strapi });
  return service;
};

const finalize = (service: any, gateway = "snappay") =>
  service.finalizeCartToOrder(23, {
    gateway,
    attemptId: "attempt-1",
    quoteHash: QUOTE_HASH,
  });

describe("finalizeCartToOrder — replaying a checkout attempt", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(["Cancelled", "Failed", "Expired"])(
    "refuses to replay a %s attempt as a conflict instead of handing back its dead state",
    async (status) => {
      findPaymentAttempt.mockResolvedValueOnce({
        attemptId: "attempt-1",
        quoteHash: QUOTE_HASH,
        Gateway: "snappay",
        Status: status,
        failureCode: "REVERT",
      });
      const service = buildService();

      const result = await finalize(service);

      expect(result).toMatchObject({ success: false, status: 409, errorCode: "CHECKOUT_ATTEMPT_CONFLICT" });
    },
  );

  it("replays an Unknown attempt so initiate can ask SnappPay before minting a second token", async () => {
    findPaymentAttempt.mockResolvedValueOnce({
      attemptId: "attempt-1",
      quoteHash: QUOTE_HASH,
      Gateway: "snappay",
      Status: "Unknown",
      order: { id: 91 },
      contract: { id: 55 },
    });
    const service = buildService();

    const result = await finalize(service);

    expect(result).toMatchObject({ success: true, replayed: true });
  });

  it("still replays a live Redirected attempt so a duplicate order is never created", async () => {
    findPaymentAttempt.mockResolvedValueOnce({
      attemptId: "attempt-1",
      quoteHash: QUOTE_HASH,
      Gateway: "snappay",
      Status: "Redirected",
      redirectUrl: "https://snapp.example/pay",
      order: { id: 91 },
      contract: { id: 55 },
    });
    const service = buildService();

    const result = await finalize(service);

    expect(result).toMatchObject({ success: true, replayed: true });
  });

  it("still replays a locally Cancelled SnappPay attempt when the provider generation is unresolved", async () => {
    findPaymentAttempt.mockResolvedValueOnce({
      attemptId: "attempt-1",
      quoteHash: QUOTE_HASH,
      Gateway: "snappay",
      Status: "Cancelled",
      providerStatus: "PENDING",
      providerResponse: { tokenAttemptSeq: 1, tokenFingerprint: "fp" },
      order: { id: 91 },
      contract: { id: 55 },
    });
    const service = buildService();

    const result = await finalize(service);

    expect(result).toMatchObject({ success: true, replayed: true });
  });
});
