/**
 * Every failure inside `finalizeCartToOrder` is reported to Sentry, mapped or not —
 * a shopper who cannot pay is the same loss either way. Severity is what separates
 * them: a mapped code is a condition we understand (stock moved, coupon exhausted),
 * an unmapped one is infrastructure. A missing `orders.analytics_correlation_id`
 * column killed checkout as the latter for four weeks without raising anything.
 */
import * as Sentry from "@sentry/node";

jest.mock("@sentry/node", () => ({ captureException: jest.fn().mockReturnValue("event-id"), isEnabled: jest.fn(() => true), logger: { info: jest.fn() } }));

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
jest.mock("../services/lib/stock", () => ({ ...jest.requireActual("../services/lib/stock"), reserveStockAtomic: jest.fn() }));
jest.mock("../services/ops/addCartItem", () => ({ addCartItemOp: jest.fn() }));
jest.mock("../services/ops/updateCartItem", () => ({ updateCartItemOp: jest.fn() }));
jest.mock("../services/ops/removeCartItem", () => ({ removeCartItemOp: jest.fn() }));
jest.mock("../services/ops/checkCartStock", () => ({ checkCartStockOp: jest.fn() }));
jest.mock("../services/lib/checkout-quote", () => ({ createCheckoutQuote: jest.fn() }));
jest.mock("../../payment-attempt/services/payment-attempt", () => ({
  createPaymentAttempt: jest.fn(),
  findPaymentAttempt: jest.fn().mockResolvedValue(null),
  updatePaymentAttempt: jest.fn(),
}));
jest.mock("../services/lib/checkout-resume", () => ({
  checkoutAttemptOrderId: jest.fn(),
  gateCheckoutResume: jest.fn(),
  RESERVATION_EXPIRED_RESULT: {
    success: false,
    status: 409,
    errorCode: "RESERVATION_EXPIRED",
  },
  RESERVATION_LOOKUP_FAILED_RESULT: {
    success: false,
    status: 503,
    errorCode: "RESERVATION_LOOKUP_FAILED",
  },
}));
jest.mock("../../payment-gateway/services/snappay-security", () => ({
  generateSnappayCallbackNonce: jest.fn(),
  generateSnappayTransactionId: jest.fn(),
  hashSnappayCallbackNonce: jest.fn(),
}));

const { createCheckoutQuote } = require("../services/lib/checkout-quote");
const createCartService = require("../services/cart").default;
const { StockReservationError } = require("../services/lib/stock");

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
  beforeEach(() => { jest.clearAllMocks(); jest.mocked(Sentry.captureException).mockReturnValue("event-id"); jest.mocked(Sentry.isEnabled).mockReturnValue(true); });

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

  it("keeps an unclassified stock failure actionable", async () => {
    const { service } = buildService(() =>
      Promise.reject(new Error("STOCK_RESERVATION_FAILED: reserve_failed")),
    );

    const result = await finalize(service);

    expect(result).toMatchObject({ success: false, errorCode: "STOCK_RESERVATION_FAILED" });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: "error",
        tags: expect.objectContaining({
          area: "checkout",
          errorCode: "STOCK_RESERVATION_FAILED",
          mapped: "true",
        }),
      }),
    );
  });

  it.each(["insufficient_stock", "database_failure", "missing_inventory", "invalid_quantity"])("classifies %s without reading provider error text", async (reason) => {
    const original = process.env.SENTRY_EXPECTED_EVENTS_TO_LOGS;
    process.env.SENTRY_EXPECTED_EVENTS_TO_LOGS = "true";
    try {
      const { service } = buildService(() => Promise.reject(new StockReservationError(reason, "private db text")));
      const result = await finalize(service);
      expect(result.telemetryOwner).toBe("backend");
      expect(result.details).toEqual(reason === "insufficient_stock" ? { reason } : {});
      if (reason === "insufficient_stock") {
        expect(Sentry.captureException).not.toHaveBeenCalled();
        expect(Sentry.logger.info).toHaveBeenCalledWith("checkout.failure", expect.objectContaining({ reasonCode: reason }));
      } else {
        expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ level: "error", tags: expect.objectContaining({ stock_failure_reason: reason }) }));
      }
    } finally { process.env.SENTRY_EXPECTED_EVENTS_TO_LOGS = original; }
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
      "Failed to report checkout failure",
      expect.any(Error),
    );
  });

  it("does not mark an unavailable backend reporter as the incident owner", async () => {
    jest.mocked(Sentry.isEnabled).mockReturnValue(false);
    const { service } = buildService(() => Promise.reject(new Error("Unknown error")));
    const result = await finalize(service);
    expect(result).toMatchObject({ success: false, errorCode: "UNKNOWN_ERROR" });
    // captureException can return an event ID even when no enabled client exists.
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(result.telemetryOwner).toBeUndefined();
  });

  it("returns CART_EMPTY when the cart has no items, so the storefront can drop it", async () => {
    const { service } = buildService(() => Promise.resolve());
    service.checkCartStock = jest.fn().mockResolvedValue({
      valid: true,
      cart: { id: 7, cart_items: [] },
    });

    const result = await finalize(service);

    expect(result).toMatchObject({
      success: false,
      errorCode: "CART_EMPTY",
      message: "Cannot create order from empty cart",
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
