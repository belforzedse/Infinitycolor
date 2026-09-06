/**
 * A failure inside `finalizeCartToOrder` whose message carries no "CODE:" prefix
 * is infrastructure, not a shopper mistake — it aborts order creation for the
 * gateway and the wallet alike, and still renders as the generic Persian
 * banner. A missing `orders.analytics_correlation_id` column killed checkout
 * this way for four weeks without raising anything.
 */
import * as Sentry from "@sentry/node";

jest.mock("@sentry/node", () => ({ captureException: jest.fn() }));

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
  findPaymentAttempt: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../payment-gateway/services/snappay-security", () => ({
  generateSnappayCallbackNonce: jest.fn(),
  generateSnappayTransactionId: jest.fn(),
  hashSnappayCallbackNonce: jest.fn(),
}));

const { createCheckoutQuote } = require("../services/lib/checkout-quote");
const createCartService = require("../services/cart").default;

const QUOTE_HASH = "quote-hash";

const buildService = (transactionImpl: () => Promise<never>) => {
  const strapi: any = {
    log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    db: { transaction: jest.fn(transactionImpl) },
    entityService: { create: jest.fn().mockResolvedValue({ id: 1 }) },
  };
  const service = createCartService({ strapi });
  service.checkCartStock = jest.fn().mockResolvedValue({
    valid: true,
    cart: { id: 7, cart_items: [{ id: 1, Count: 1 }] },
  });
  createCheckoutQuote.mockResolvedValue({
    quoteHash: QUOTE_HASH,
    financialSummary: { total: 1000, discount: 0 },
  });
  return { service, strapi };
};

const finalize = (service: any) =>
  service.finalizeCartToOrder(23, {
    gateway: "mellat",
    attemptId: "attempt-1",
    quoteHash: QUOTE_HASH,
  });

describe("finalizeCartToOrder — unmapped failures", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reports a colon-less database failure and still returns the shopper-facing 400 shape", async () => {
    const dbError = new Error(
      'insert into "public"."orders" ... - column "analytics_correlation_id" of relation "orders" does not exist',
    );
    const { service } = buildService(() => Promise.reject(dbError));

    const result = await finalize(service);

    expect(result).toMatchObject({
      success: false,
      errorCode: "UNKNOWN_ERROR",
      message: "خطا در ثبت سفارش",
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      dbError,
      expect.objectContaining({
        tags: expect.objectContaining({ area: "checkout", errorCode: "UNKNOWN_ERROR" }),
      }),
    );
  });

  it("does not report failures that already carry a mapped error code", async () => {
    const { service } = buildService(() =>
      Promise.reject(new Error("STOCK_RESERVATION_FAILED: reserve_failed")),
    );

    const result = await finalize(service);

    expect(result).toMatchObject({ success: false, errorCode: "STOCK_RESERVATION_FAILED" });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("never lets a reporting failure escalate the shopper's 400 into a 500", async () => {
    const { service, strapi } = buildService(() => Promise.reject(new Error("Unknown error")));
    (Sentry.captureException as jest.Mock).mockImplementation(() => {
      throw new Error("sentry transport is down");
    });

    await expect(finalize(service)).resolves.toMatchObject({
      success: false,
      errorCode: "UNKNOWN_ERROR",
    });
    expect(strapi.log.error).toHaveBeenCalledWith(
      "Failed to report unmapped checkout failure",
      expect.any(Error),
    );
  });
});
