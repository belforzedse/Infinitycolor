import { verifyPaymentHandler } from "../../order/controllers/helpers/payment";
import { decrementStockAtomic } from "../../cart/services/lib/stock";
import { consumeOrderReservation } from "../../../utils/stockReservations";
import {
  settleZarinPalPayment,
  ZarinPalSettlementError,
} from "../../order/controllers/helpers/zarinpalSettlement";

jest.mock("../../cart/services/lib/stock", () => ({
  decrementStockAtomic: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock("../../../utils/stockReservations", () => ({
  consumeOrderReservation: jest.fn().mockResolvedValue({ outcome: "consumed" }),
  releaseOrderReservation: jest.fn().mockResolvedValue({ outcome: "released" }),
}));

jest.mock("../../order/controllers/helpers/zarinpalSettlement", () => {
  class MockZarinPalSettlementError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "ZarinPalSettlementError";
    }
  }
  return {
    settleZarinPalPayment: jest.fn(),
    ZarinPalSettlementError: MockZarinPalSettlementError,
  };
});

const mockedSettleZarinPalPayment = settleZarinPalPayment as jest.MockedFunction<
  typeof settleZarinPalPayment
>;
const originalFrontendBaseUrl = process.env.FRONTEND_BASE_URL;

type StrapiMockHelpers = ReturnType<typeof createStrapiMock>;

const createCtx = (overrides: Partial<any> = {}) => {
  const ctx: any = {
    request: {
      method: "POST",
      ip: "127.0.0.1",
      header: {
        "content-type": "application/json",
        "user-agent": "jest",
        "x-forwarded-for": "127.0.0.1",
      },
      body: {},
      query: {},
      ...overrides.request,
    },
    badRequest: jest.fn(),
    redirect: jest.fn(),
    ...overrides,
  };

  return ctx;
};

const createStrapiMock = () => {
  const serviceMap: Record<string, any> = {};
  const dbQueryMap: Record<string, any> = {};
  const strapi: any = {
    log: {
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
    },
    entityService: {
      findOne: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    service: jest.fn((uid: string) => serviceMap[uid]),
    db: {
      query: jest.fn((uid: string) => {
        if (!dbQueryMap[uid]) {
          dbQueryMap[uid] = {
            findOne: jest.fn(async (options: any) => {
              if (uid === "api::contract.contract") {
                return { id: Number(options?.where?.id), Status: "Pending" };
              }
              return strapi.entityService.findOne(uid, Number(options?.where?.id), options);
            }),
            create: jest.fn((options: any) => strapi.entityService.create(uid, options)),
            update: jest.fn((options: any) =>
              strapi.entityService.update(uid, Number(options?.where?.id), {
                data: options?.data,
              }),
            ),
            delete: jest.fn(),
          };
        }
        return dbQueryMap[uid];
      }),
      transaction: jest.fn(async (cb: any) =>
        cb({
          trx: {
            id: "trx",
            raw: jest.fn((sql: string, bindings: unknown[]) =>
              String(sql).includes("FROM orders")
                ? Promise.resolve({ rows: [{ id: Number(bindings?.[0]) }] })
                : strapi.db.connection.raw(sql, bindings),
            ),
          },
        }),
      ),
      connection: {
        raw: jest.fn().mockResolvedValue({ rows: [] }),
      },
    },
  };

  const registerService = (uid: string, impl: any) => {
    serviceMap[uid] = impl;
  };

  const getDbQuery = (uid: string) => strapi.db.query(uid);

  return { strapi, registerService, getDbQuery };
};

/** Registers the payment_attempts row that Mellat correlation looks up by RefId. */
const mockMellatAttempt = (
  getDbQuery: ReturnType<typeof createStrapiMock>["getDbQuery"],
  attempt: any,
) => {
  (getDbQuery("api::payment-attempt.payment-attempt").findOne as jest.Mock).mockResolvedValue(
    attempt,
  );
};

describe("verifyPaymentHandler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FRONTEND_BASE_URL = "https://infinitycolor.co";
    mockedSettleZarinPalPayment.mockResolvedValue({
      success: true,
      replayed: false,
      finalReference: "ZP-REF-1",
    });
  });

  afterAll(() => {
    if (originalFrontendBaseUrl === undefined) {
      delete process.env.FRONTEND_BASE_URL;
    } else {
      process.env.FRONTEND_BASE_URL = originalFrontendBaseUrl;
    }
  });

  it("cancels the order and redirects when Mellat reports a failure", async () => {
    const { strapi, getDbQuery } = createStrapiMock();
    mockMellatAttempt(getDbQuery, { id: 55, order: { id: 100 } });
    (strapi.entityService.findOne as jest.Mock).mockResolvedValue({
      id: 100,
      Status: "Paying",
      user: { id: 9 },
      contract: { id: 75, Status: "Pending" },
    });
    strapi.db.connection.raw.mockResolvedValue({ rows: [{ id: 55 }] });

    const ctx = createCtx({
      request: {
        body: {
          ResCode: "17",
          OrderId: "100",
          SaleOrderId: "100",
          SaleReferenceId: "ABC",
          RefId: "XYZ",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(strapi.entityService.update).toHaveBeenCalledWith(
      "api::order.order",
      100,
      { data: { Status: "Cancelled" } },
    );
    expect(strapi.entityService.create).toHaveBeenCalledWith(
      "api::order-log.order-log",
      expect.objectContaining({
        data: expect.objectContaining({
          order: 100,
          Description: "Gateway callback failure/cancellation",
        }),
      }),
    );
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=cancelled&orderId=100&reason=user-cancelled",
    );
  });

  it("ignores a Mellat failure callback that cannot be correlated to a known attempt (Finding B)", async () => {
    const { strapi, getDbQuery } = createStrapiMock();
    mockMellatAttempt(getDbQuery, null);

    const ctx = createCtx({
      request: {
        body: {
          ResCode: "17",
          OrderId: "100",
          SaleOrderId: "100",
          RefId: "UNKNOWN-REFID",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(strapi.entityService.update).not.toHaveBeenCalled();
    expect(strapi.entityService.create).not.toHaveBeenCalledWith(
      "api::order-log.order-log",
      expect.anything(),
    );
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=cancelled&reason=user-cancelled",
    );
  });

  it("ignores a Mellat failure callback for an order that already settled (stale/duplicate)", async () => {
    const { strapi, getDbQuery } = createStrapiMock();
    mockMellatAttempt(getDbQuery, { id: 55, order: { id: 100 } });
    (strapi.entityService.findOne as jest.Mock).mockResolvedValue({
      id: 100,
      Status: "Started",
      user: { id: 9 },
    });

    const ctx = createCtx({
      request: {
        body: {
          ResCode: "17",
          OrderId: "100",
          SaleOrderId: "100",
          RefId: "XYZ",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    // Order already paid — a stale/duplicate failure callback must never cancel it.
    expect(strapi.entityService.update).not.toHaveBeenCalledWith(
      "api::order.order",
      100,
      expect.objectContaining({ data: expect.objectContaining({ Status: "Cancelled" }) }),
    );
  });

  it("settles a successful Mellat callback and consumes the reservation", async () => {
    const { strapi, registerService, getDbQuery } = createStrapiMock();
    const mellatService = {
      verifyTransaction: jest.fn().mockResolvedValue({ success: true }),
      settleTransaction: jest.fn().mockResolvedValue({
        success: true,
        resCode: 0,
      }),
    };
    registerService("api::payment-gateway.mellat-v3", mellatService);
    mockMellatAttempt(getDbQuery, {
      id: 55,
      order: { id: 200 },
      Amount: "1200000",
      Status: "Succeeded",
    });
    strapi.db.connection.raw.mockResolvedValue({ rows: [{ id: 55 }] });

    const orderWithItems = {
      id: 200,
      ReservationStatus: "Reserved",
      ReservedUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      contract: { id: 77, Amount: 120000 },
      order_items: [
        {
          Count: 2,
          product_variation: {
            product_stock: { id: 5, Count: 10 },
          },
        },
      ],
    };
    (strapi.entityService.findOne as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return orderWithItems;
      return null;
    });

    const ctx = createCtx({
      request: {
        body: {
          ResCode: "0",
          OrderId: "200",
          SaleOrderId: "200",
          SaleReferenceId: "REF-123",
          RefId: "MELLAT-REFID-200",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(mellatService.verifyTransaction).toHaveBeenCalledWith({
      orderId: "200",
      saleOrderId: "200",
      saleReferenceId: "REF-123",
    });
    expect(mellatService.settleTransaction).toHaveBeenCalled();

    // Reserved orders consume the reservation atomically; the legacy direct
    // decrement path is unreachable for Mellat (Task 7 / Finding D).
    expect(consumeOrderReservation).toHaveBeenCalledWith(strapi, 200, expect.anything());
    expect(decrementStockAtomic).not.toHaveBeenCalled();
    expect(strapi.entityService.update).toHaveBeenCalledWith(
      "api::order.order",
      200,
      expect.objectContaining({ data: { Status: "Started" } }),
    );
    expect(strapi.entityService.create).toHaveBeenCalledWith(
      "api::order-log.order-log",
      expect.objectContaining({
        data: expect.objectContaining({
          Description: "Gateway callback success (verify+settle)",
        }),
      }),
    );
    // Without this row Mellat sales are invisible to every product report and
    // the callback idempotency check can never match.
    expect(strapi.entityService.create).toHaveBeenCalledWith(
      "api::contract-transaction.contract-transaction",
      expect.objectContaining({
        data: expect.objectContaining({
          Type: "Gateway",
          Status: "Success",
          Amount: 1200000,
          external_source: "Mellat",
          external_id: "REF-123",
          contract: 77,
        }),
      }),
    );
    expect(strapi.entityService.update).toHaveBeenCalledWith(
      "api::contract.contract",
      77,
      expect.objectContaining({
        data: expect.objectContaining({ Status: "Confirmed", external_source: "Mellat" }),
      }),
    );
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=success&orderId=200",
    );
  });

  it("redirects to success when a Mellat callback was already processed", async () => {
    const { strapi, registerService } = createStrapiMock();
    const mellatService = {
      verifyTransaction: jest.fn(),
      settleTransaction: jest.fn(),
    };
    registerService("api::payment-gateway.mellat-v3", mellatService);

    // The settled transaction written by a previous callback.
    (strapi.entityService.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 900,
        external_source: "Mellat",
        external_id: "REF-123",
        Status: "Success",
        contract: { order: { id: 200 } },
      },
    ]);

    const ctx = createCtx({
      request: {
        body: {
          ResCode: "0",
          OrderId: "200",
          SaleOrderId: "200",
          SaleReferenceId: "REF-123",
          RefId: "MELLAT-REFID-200",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    // Replay must be rejected before any money or stock movement.
    expect(mellatService.verifyTransaction).not.toHaveBeenCalled();
    expect(mellatService.settleTransaction).not.toHaveBeenCalled();
    expect(decrementStockAtomic).not.toHaveBeenCalled();
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=success&orderId=200",
    );
  });

  it("rejects a Mellat callback whose RefId is unknown (Test 3: unknown attempt)", async () => {
    const { strapi, registerService, getDbQuery } = createStrapiMock();
    const mellatService = {
      verifyTransaction: jest.fn(),
      settleTransaction: jest.fn(),
    };
    registerService("api::payment-gateway.mellat-v3", mellatService);
    mockMellatAttempt(getDbQuery, null);

    const ctx = createCtx({
      request: {
        body: {
          ResCode: "0",
          OrderId: "200",
          SaleOrderId: "200",
          SaleReferenceId: "REF-UNKNOWN",
          RefId: "REFID-NEVER-ISSUED",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(mellatService.verifyTransaction).not.toHaveBeenCalled();
    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Invalid payment reference",
      expect.objectContaining({ data: expect.objectContaining({ success: false }) }),
    );
  });

  it("rejects a Mellat callback whose OrderId doesn't match the attempt's own order (Test 1: cross-order)", async () => {
    const { strapi, registerService, getDbQuery } = createStrapiMock();
    const mellatService = {
      verifyTransaction: jest.fn(),
      settleTransaction: jest.fn(),
    };
    registerService("api::payment-gateway.mellat-v3", mellatService);
    // RefId genuinely belongs to order 200, but the caller supplies order 999.
    mockMellatAttempt(getDbQuery, {
      id: 55,
      order: { id: 200 },
      Amount: "1200000",
      Status: "Succeeded",
    });

    const ctx = createCtx({
      request: {
        body: {
          ResCode: "0",
          OrderId: "999",
          SaleOrderId: "999",
          SaleReferenceId: "REF-123",
          RefId: "MELLAT-REFID-200",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(mellatService.verifyTransaction).not.toHaveBeenCalled();
    expect(strapi.entityService.update).not.toHaveBeenCalled();
    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Invalid order reference",
      expect.objectContaining({ data: expect.objectContaining({ success: false }) }),
    );
  });

  it("rejects a Mellat callback with no RefId at all (malformed input)", async () => {
    const { strapi, registerService } = createStrapiMock();
    const mellatService = {
      verifyTransaction: jest.fn(),
      settleTransaction: jest.fn(),
    };
    registerService("api::payment-gateway.mellat-v3", mellatService);

    const ctx = createCtx({
      request: {
        body: { ResCode: "0", OrderId: "200", SaleOrderId: "200", SaleReferenceId: "REF-123" },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(mellatService.verifyTransaction).not.toHaveBeenCalled();
    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Invalid payment reference",
      expect.objectContaining({ data: expect.objectContaining({ success: false }) }),
    );
  });

  it("only lets one of two concurrent duplicate Mellat successes finalize the order (Test 5)", async () => {
    const { strapi, registerService, getDbQuery } = createStrapiMock();
    const mellatService = {
      verifyTransaction: jest.fn().mockResolvedValue({ success: true }),
      settleTransaction: jest.fn().mockResolvedValue({ success: true, resCode: 0 }),
    };
    registerService("api::payment-gateway.mellat-v3", mellatService);
    mockMellatAttempt(getDbQuery, {
      id: 55,
      order: { id: 200 },
      Amount: "1200000",
      Status: "Succeeded",
    });

    const orderWithItems = {
      id: 200,
      ReservationStatus: "Reserved",
      ReservedUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      contract: { id: 77, Amount: 120000 },
      order_items: [],
    };
    (strapi.entityService.findOne as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return orderWithItems;
      if (uid === "api::payment-attempt.payment-attempt") return { Status: "Succeeded" };
      return null;
    });

    // Simulate the guarded CAS UPDATE: the first caller's raw claim wins
    // (returns a row), the second caller's identical claim loses (0 rows) —
    // this is the same primitive that would serialize two real concurrent
    // Postgres transactions racing the same UPDATE...WHERE...RETURNING, but
    // this suite mocks the raw-SQL layer rather than a live database, so it
    // demonstrates the winner/loser branching, not live-DB atomicity.
    strapi.db.connection.raw
      .mockResolvedValueOnce({ rows: [{ id: 55 }] })
      .mockResolvedValueOnce({ rows: [] });

    const body = {
      ResCode: "0",
      OrderId: "200",
      SaleOrderId: "200",
      SaleReferenceId: "REF-123",
      RefId: "MELLAT-REFID-200",
    };

    const ctxA = createCtx({ request: { body } });
    const ctxB = createCtx({ request: { body } });

    await Promise.all([
      verifyPaymentHandler(strapi as any, ctxA),
      verifyPaymentHandler(strapi as any, ctxB),
    ]);

    // Only the winner transitions the order to Started.
    const startedCalls = (strapi.entityService.update as jest.Mock).mock.calls.filter(
      ([uid, id, payload]: any[]) =>
        uid === "api::order.order" && id === 200 && payload?.data?.Status === "Started",
    );
    expect(startedCalls).toHaveLength(1);
    expect(ctxA.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=success&orderId=200",
    );
    expect(ctxB.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=success&orderId=200",
    );
    // Pin the actual concurrency primitive, not just its observed effect —
    // this would still pass if a future edit accidentally widened the
    // guarded status set, so assert the claim's WHERE clause directly.
    const claimSql = strapi.db.connection.raw.mock.calls
      .map(([sql]: any[]) => String(sql))
      .find((sql: string) => sql.includes("payment_attempts") && sql.includes("SET status"));
    expect(claimSql).toEqual(expect.stringContaining("status IN ('Pending', 'Redirected')"));
  });

  it("does not cancel an already-succeeded Mellat attempt on a stale duplicate failure (Test 7)", async () => {
    const { strapi, getDbQuery } = createStrapiMock();
    mockMellatAttempt(getDbQuery, { id: 55, order: { id: 200 } });
    (strapi.entityService.findOne as jest.Mock).mockResolvedValue({
      id: 200,
      Status: "Started",
      user: { id: 9 },
    });
    // The claim-to-Failed CAS loses because the attempt is already Succeeded.
    strapi.db.connection.raw.mockResolvedValue({ rows: [] });

    const ctx = createCtx({
      request: {
        body: { ResCode: "17", OrderId: "200", SaleOrderId: "200", RefId: "MELLAT-REFID-200" },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(strapi.entityService.update).not.toHaveBeenCalledWith(
      "api::order.order",
      200,
      expect.objectContaining({ data: expect.objectContaining({ Status: "Cancelled" }) }),
    );
  });

  it("does not settle when the reservation was already released before Mellat could consume it (Test 9: skipped)", async () => {
    const { strapi, registerService, getDbQuery } = createStrapiMock();
    const mellatService = {
      verifyTransaction: jest.fn().mockResolvedValue({ success: true }),
      settleTransaction: jest.fn().mockResolvedValue({ success: true, resCode: 0 }),
    };
    registerService("api::payment-gateway.mellat-v3", mellatService);
    mockMellatAttempt(getDbQuery, { id: 55, order: { id: 200 }, Amount: "1200000" });
    strapi.db.connection.raw.mockResolvedValue({ rows: [{ id: 55 }] });

    const orderWithItems = {
      id: 200,
      ReservationStatus: "Reserved",
      ReservedUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      contract: { id: 77, Amount: 120000 },
      order_items: [],
    };
    (strapi.entityService.findOne as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return orderWithItems;
      return null;
    });
    // The reservation was already released/expired by something else (an
    // expiry-job tick, a duplicate callback) between the pre-check and the
    // atomic consume attempt — nothing was actually decremented.
    (consumeOrderReservation as jest.Mock).mockResolvedValueOnce({
      outcome: "skipped",
      reason: "not_reserved",
      expired: false,
    });

    const ctx = createCtx({
      request: {
        body: {
          ResCode: "0",
          OrderId: "200",
          SaleOrderId: "200",
          SaleReferenceId: "REF-123",
          RefId: "MELLAT-REFID-200",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(strapi.entityService.update).not.toHaveBeenCalledWith(
      "api::order.order",
      200,
      expect.objectContaining({ data: expect.objectContaining({ Status: "Started" }) }),
    );
  });

  it("treats a Mellat callback for an already-consumed order as an idempotent no-op (Test 10)", async () => {
    const { strapi, registerService, getDbQuery } = createStrapiMock();
    const mellatService = {
      verifyTransaction: jest.fn(),
      settleTransaction: jest.fn(),
    };
    registerService("api::payment-gateway.mellat-v3", mellatService);
    mockMellatAttempt(getDbQuery, { id: 55, order: { id: 200 }, Amount: "1200000" });
    (strapi.entityService.findOne as jest.Mock).mockResolvedValue({
      id: 200,
      ReservationStatus: "Consumed",
    });

    const ctx = createCtx({
      request: {
        body: {
          ResCode: "0",
          OrderId: "200",
          SaleOrderId: "200",
          SaleReferenceId: "REF-123",
          RefId: "MELLAT-REFID-200",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(mellatService.verifyTransaction).not.toHaveBeenCalled();
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=success&orderId=200",
    );
  });

  it("rejects legacy SnappPay input on the shared callback endpoint", async () => {
    const { strapi, registerService } = createStrapiMock();
    const legacyService = {
      status: jest.fn(),
      verify: jest.fn(),
      settle: jest.fn(),
      revert: jest.fn(),
    };
    registerService("api::payment-gateway.snappay", legacyService);
    const ctx = createCtx({
      request: {
        body: {
          state: "OK",
          transactionId: "SN-LEGACY",
          paymentToken: "must-not-be-accepted",
          OrderId: "700",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith(
      "SnappPay callback endpoint has changed",
      {
        data: {
          success: false,
          errorCode: "SNAPPAY_LEGACY_CALLBACK_DISABLED",
        },
      },
    );
    expect(legacyService.status).not.toHaveBeenCalled();
    expect(legacyService.verify).not.toHaveBeenCalled();
    expect(legacyService.settle).not.toHaveBeenCalled();
    expect(legacyService.revert).not.toHaveBeenCalled();
    expect(decrementStockAtomic).not.toHaveBeenCalled();
  });

  it("redirects to success when a ZarinPal callback was already processed", async () => {
    const { strapi } = createStrapiMock();
    (strapi.entityService.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 901,
        Status: "Success",
        contract: {
          id: 801,
          order: { id: 701 },
        },
      },
    ]);

    const ctx = createCtx({
      request: {
        query: {
          Authority: "AUTH-DONE",
          Status: "OK",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=success&orderId=701",
    );
    expect(strapi.service).not.toHaveBeenCalledWith("api::payment-gateway.zarinpal");
  });

  it("marks a ZarinPal callback as cancelled when gateway status is not OK", async () => {
    const { strapi } = createStrapiMock();
    (strapi.entityService.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 902,
        Status: "Pending",
        contract: {
          id: 802,
          Amount: 15_000,
          order: { id: 702 },
        },
      },
    ]);
    (strapi.entityService.findOne as jest.Mock).mockResolvedValue({
      id: 702,
      Status: "Paying",
      contract: { id: 802, Amount: 15_000 },
    });

    const ctx = createCtx({
      request: {
        query: {
          Authority: "AUTH-CANCEL",
          Status: "NOK",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(strapi.entityService.update).toHaveBeenCalledWith(
      "api::contract-transaction.contract-transaction",
      902,
      expect.objectContaining({
        data: expect.objectContaining({
          Status: "Failed",
          GatewayAuthority: "AUTH-CANCEL",
          GatewayStatus: "NOK",
        }),
      }),
    );
    expect(strapi.entityService.update).toHaveBeenCalledWith(
      "api::order.order",
      702,
      {
        data: {
          Status: "Cancelled",
          external_source: "ZarinPal",
          external_id: "AUTH-CANCEL",
        },
      },
    );
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=cancelled&orderId=702&error=NOK&reason=user-cancelled",
    );
  });

  it("redirects ZarinPal callbacks with unknown authority to failure", async () => {
    const { strapi } = createStrapiMock();
    (strapi.entityService.findMany as jest.Mock).mockResolvedValue([]);

    const ctx = createCtx({
      request: {
        query: {
          Authority: "AUTH-MISSING",
          Status: "OK",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(strapi.entityService.findMany).toHaveBeenCalledTimes(3);
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=failure&error=ZarinPal+transaction+not+found",
    );
  });

  it("verifies a successful ZarinPal callback, finalizes records, and redirects", async () => {
    const { strapi, registerService } = createStrapiMock();
    const zarinpalService = {
      verifyPayment: jest.fn().mockResolvedValue({
        success: true,
        alreadyVerified: false,
        code: 100,
        refId: "ZP-REF-1",
        gatewayResponse: { data: { code: 100, ref_id: "ZP-REF-1" } },
      }),
    };
    registerService("api::payment-gateway.zarinpal", zarinpalService);

    (strapi.entityService.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 903,
        Status: "Pending",
        Amount: 25_000,
        contract: {
          id: 803,
          Amount: 25_000,
          order: { id: 703 },
        },
      },
    ]);
    (strapi.entityService.findOne as jest.Mock).mockResolvedValue({
      id: 703,
      Status: "Paying",
      ReservationStatus: "None",
      contract: { id: 803, Amount: 25_000 },
      order_items: [
        {
          Count: 2,
          product_variation: {
            id: 55,
            product_stock: { id: 305 },
          },
        },
      ],
    });

    const ctx = createCtx({
      request: {
        query: {
          Authority: "AUTH-OK",
          Status: "OK",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(zarinpalService.verifyPayment).toHaveBeenCalledWith({
      authority: "AUTH-OK",
      amountToman: 25_000,
    });
    expect(mockedSettleZarinPalPayment).toHaveBeenCalledWith(strapi, {
      orderId: 703,
      contractId: 803,
      contractTransactionId: 903,
      authority: "AUTH-OK",
      verification: expect.objectContaining({
        success: true,
        refId: "ZP-REF-1",
      }),
    });
    expect(strapi.entityService.create).toHaveBeenCalledWith(
      "api::order-log.order-log",
      expect.objectContaining({
        data: expect.objectContaining({
          order: 703,
          Description: "ZarinPal gateway verify succeeded",
          Changes: expect.objectContaining({
            authority: "AUTH-OK",
            refId: "ZP-REF-1",
            code: 100,
          }),
        }),
      }),
    );
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=success&orderId=703&transactionId=ZP-REF-1",
    );
  });

  it("marks a ZarinPal callback failed when verification fails", async () => {
    const { strapi, registerService } = createStrapiMock();
    registerService("api::payment-gateway.zarinpal", {
      verifyPayment: jest.fn().mockResolvedValue({
        success: false,
        code: -51,
        error: "Authority invalid",
      }),
    });
    (strapi.entityService.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 904,
        Status: "Pending",
        Amount: 30_000,
        contract: {
          id: 804,
          Amount: 30_000,
          order: { id: 704 },
        },
      },
    ]);
    (strapi.entityService.findOne as jest.Mock).mockResolvedValue({
      id: 704,
      Status: "Paying",
      contract: { id: 804, Amount: 30_000 },
    });

    const ctx = createCtx({
      request: {
        query: {
          Authority: "AUTH-FAIL",
          Status: "OK",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(strapi.entityService.update).toHaveBeenCalledWith(
      "api::contract-transaction.contract-transaction",
      904,
      expect.objectContaining({
        data: expect.objectContaining({
          Status: "Failed",
          GatewayAuthority: "AUTH-FAIL",
          GatewayStatus: "OK",
          GatewayResponse: expect.objectContaining({
            reason: "Authority invalid",
          }),
        }),
      }),
    );
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=failure&orderId=704&error=Authority+invalid",
    );
  });

  it("does not finalize a ZarinPal order when the reservation expired before settlement", async () => {
    const { strapi, registerService } = createStrapiMock();
    registerService("api::payment-gateway.zarinpal", {
      verifyPayment: jest.fn().mockResolvedValue({
        success: true,
        alreadyVerified: false,
        code: 100,
        refId: "ZP-REF-EXP",
        gatewayResponse: { data: { code: 100 } },
      }),
    });
    (strapi.entityService.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 905,
        Status: "Pending",
        Amount: 20_000,
        contract: { id: 805, Amount: 20_000, order: { id: 705 } },
      },
    ]);
    (strapi.entityService.findOne as jest.Mock).mockResolvedValue({
      id: 705,
      Status: "Paying",
      ReservationStatus: "Reserved",
      contract: { id: 805, Amount: 20_000 },
    });
    mockedSettleZarinPalPayment.mockRejectedValueOnce(
      new ZarinPalSettlementError(
        "ZARINPAL_LOCAL_STATE_CONFLICT",
        "Reservation expired",
      ),
    );

    const ctx = createCtx({
      request: { query: { Authority: "AUTH-EXP", Status: "OK" } },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    // The shopper is routed to the canonical issue state, never success.
    expect(ctx.redirect).toHaveBeenCalledWith(
      expect.stringContaining("/payment/result?resultHint=issue"),
    );
    expect(ctx.redirect).toHaveBeenCalledWith(
      expect.stringContaining("code=zarinpal_local_state_conflict"),
    );
  });

  it("keeps the order payable when ZarinPal verification is ambiguous", async () => {
    const { strapi, registerService } = createStrapiMock();
    registerService("api::payment-gateway.zarinpal", {
      verifyPayment: jest.fn().mockResolvedValue({
        success: false,
        ambiguous: true,
        error: "socket timeout",
        gatewayResponse: { status: 504 },
      }),
    });
    (strapi.entityService.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 906,
        Status: "Pending",
        Amount: 30_000,
        contract: { id: 806, Amount: 30_000, order: { id: 706 } },
      },
    ]);
    (strapi.entityService.findOne as jest.Mock).mockResolvedValueOnce({
      id: 706,
      Status: "Paying",
      ReservationStatus: "Reserved",
      contract: { id: 806, Amount: 30_000 },
    });

    const ctx = createCtx({
      request: { query: { Authority: "AUTH-UNKNOWN", Status: "OK" } },
    });
    await verifyPaymentHandler(strapi as any, ctx);

    expect(strapi.entityService.update).toHaveBeenCalledWith(
      "api::contract-transaction.contract-transaction",
      906,
      expect.objectContaining({
        data: expect.objectContaining({
          GatewayStatus: "VERIFICATION_AMBIGUOUS",
        }),
      }),
    );
    expect(strapi.entityService.update).not.toHaveBeenCalledWith(
      "api::order.order",
      706,
      expect.objectContaining({ data: expect.objectContaining({ Status: "Cancelled" }) }),
    );
    expect(mockedSettleZarinPalPayment).not.toHaveBeenCalled();
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=issue&orderId=706&code=zarinpal_verification_ambiguous",
    );
  });
});
