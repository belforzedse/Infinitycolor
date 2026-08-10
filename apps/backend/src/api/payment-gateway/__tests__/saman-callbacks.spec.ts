import { verifyPaymentHandler } from "../../order/controllers/helpers/payment";
import { decrementStockAtomic } from "../../cart/services/lib/stock";
import { consumeOrderReservation } from "../../../utils/stockReservations";

jest.mock("../../cart/services/lib/stock", () => ({
  decrementStockAtomic: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock("../../../utils/stockReservations", () => ({
  consumeOrderReservation: jest.fn().mockResolvedValue({ success: true }),
  releaseOrderReservation: jest.fn().mockResolvedValue({ success: true }),
}));

const originalFrontendBaseUrl = process.env.FRONTEND_BASE_URL;

const createCtx = (overrides: Partial<any> = {}) => {
  const ctx: any = {
    request: {
      method: "POST",
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
            findOne: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
          };
        }
        return dbQueryMap[uid];
      }),
      transaction: jest.fn(async (cb: any) => cb({ trx: { id: "trx" } })),
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

/** Registers the newest payment_attempts row `findOrderPaymentAttempt` returns for an order. */
const mockSamanAttempt = (
  getDbQuery: ReturnType<typeof createStrapiMock>["getDbQuery"],
  attempt: any,
) => {
  (getDbQuery("api::payment-attempt.payment-attempt").findOne as jest.Mock).mockResolvedValue(
    attempt,
  );
};

const ORDER_ID = 300;
const RES_NUM = "300-1699999999999-abc123";
const REF_NUM = "SAMAN-REFNUM-1";

/** Order row returned for the correlation anchor lookup (findMany by external_id/external_source). */
const anchorOrderRow = (id = ORDER_ID) => [{ id }];

const baseOrderEntity = (overrides: Partial<any> = {}) => ({
  id: ORDER_ID,
  Status: "Paying",
  ReservationStatus: "Reserved",
  ReservedUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  DiscountCode: null,
  contract: { id: 88, Amount: 150000 },
  order_items: [],
  ...overrides,
});

describe("verifyPaymentHandler (Saman)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FRONTEND_BASE_URL = "https://infinitycolor.co";
  });

  afterAll(() => {
    if (originalFrontendBaseUrl === undefined) {
      delete process.env.FRONTEND_BASE_URL;
    } else {
      process.env.FRONTEND_BASE_URL = originalFrontendBaseUrl;
    }
  });

  it("rejects a Saman callback with no ResNum at all (malformed input)", async () => {
    const { strapi, registerService } = createStrapiMock();
    const samanService = { verifyTransaction: jest.fn(), reverseTransaction: jest.fn() };
    registerService("api::payment-gateway.saman-kish", samanService);

    const ctx = createCtx({ request: { body: { State: "OK", RefNum: REF_NUM } } });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(samanService.verifyTransaction).not.toHaveBeenCalled();
    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Invalid order reference",
      expect.objectContaining({ data: expect.objectContaining({ success: false }) }),
    );
  });

  it("rejects a forged/unknown ResNum that matches no order (Test 1: cross-order / Finding A)", async () => {
    const { strapi, registerService } = createStrapiMock();
    const samanService = { verifyTransaction: jest.fn(), reverseTransaction: jest.fn() };
    registerService("api::payment-gateway.saman-kish", samanService);
    // No contract-transaction match, no order anchor match.
    (strapi.entityService.findMany as jest.Mock).mockResolvedValue([]);

    const ctx = createCtx({
      request: { body: { State: "OK", RefNum: REF_NUM, ResNum: "999-forged-resnum" } },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(samanService.verifyTransaction).not.toHaveBeenCalled();
    expect(strapi.entityService.update).not.toHaveBeenCalled();
    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Invalid order reference",
      expect.objectContaining({ data: expect.objectContaining({ success: false }) }),
    );
  });

  it("rejects a stale ResNum from a superseded retry attempt (Test 8: old attempt after newer attempt)", async () => {
    const { strapi, registerService } = createStrapiMock();
    const samanService = { verifyTransaction: jest.fn(), reverseTransaction: jest.fn() };
    registerService("api::payment-gateway.saman-kish", samanService);
    // orders.external_id was overwritten by a later retry's resNum, so the
    // old attempt's resNum no longer matches any order's current anchor.
    (strapi.entityService.findMany as jest.Mock).mockResolvedValue([]);

    const ctx = createCtx({
      request: { body: { State: "OK", RefNum: REF_NUM, ResNum: "300-OLD-RESNUM" } },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(samanService.verifyTransaction).not.toHaveBeenCalled();
    expect(strapi.entityService.update).not.toHaveBeenCalled();
  });

  it("settles a successful Saman callback and consumes the reservation", async () => {
    const { strapi, registerService, getDbQuery } = createStrapiMock();
    const samanService = {
      verifyTransaction: jest.fn().mockResolvedValue({
        success: true,
        resultCode: 0,
        transactionDetail: { AffectiveAmount: 1500000 },
      }),
      reverseTransaction: jest.fn(),
    };
    registerService("api::payment-gateway.saman-kish", samanService);
    mockSamanAttempt(getDbQuery, { id: 66, Amount: "1500000" });
    strapi.db.connection.raw.mockResolvedValue({ rows: [{ id: 66 }] });

    (strapi.entityService.findMany as jest.Mock).mockImplementation(
      async (uid: string, opts: any) => {
        if (uid === "api::order.order") return anchorOrderRow();
        return [];
      },
    );
    (strapi.entityService.findOne as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return baseOrderEntity();
      return null;
    });

    const ctx = createCtx({
      request: { body: { State: "OK", RefNum: REF_NUM, ResNum: RES_NUM } },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(samanService.verifyTransaction).toHaveBeenCalledWith({ refNum: REF_NUM });
    expect(consumeOrderReservation).toHaveBeenCalledWith(strapi, ORDER_ID, expect.anything());
    expect(decrementStockAtomic).not.toHaveBeenCalled();
    expect(strapi.entityService.update).toHaveBeenCalledWith(
      "api::order.order",
      ORDER_ID,
      expect.objectContaining({ data: expect.objectContaining({ Status: "Started" }) }),
    );
    expect(ctx.redirect).toHaveBeenCalledWith(
      expect.stringContaining("https://infinitycolor.co/payment/result?resultHint=success"),
    );
  });

  it("reverses and does not settle when the affective amount does not match (Test 2: amount mismatch)", async () => {
    const { strapi, registerService, getDbQuery } = createStrapiMock();
    const samanService = {
      verifyTransaction: jest.fn().mockResolvedValue({
        success: true,
        resultCode: 0,
        // Provider settled a different amount than what the attempt expects.
        transactionDetail: { AffectiveAmount: 999999 },
      }),
      reverseTransaction: jest.fn().mockResolvedValue({ success: true }),
    };
    registerService("api::payment-gateway.saman-kish", samanService);
    mockSamanAttempt(getDbQuery, { id: 66, Amount: "1500000" });

    (strapi.entityService.findMany as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return anchorOrderRow();
      return [];
    });
    (strapi.entityService.findOne as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return baseOrderEntity();
      return null;
    });

    const ctx = createCtx({
      request: { body: { State: "OK", RefNum: REF_NUM, ResNum: RES_NUM } },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(samanService.reverseTransaction).toHaveBeenCalledWith({ refNum: REF_NUM });
    expect(strapi.entityService.update).not.toHaveBeenCalledWith(
      "api::order.order",
      ORDER_ID,
      expect.objectContaining({ data: expect.objectContaining({ Status: "Started" }) }),
    );
    expect(ctx.redirect).toHaveBeenCalledWith(
      expect.stringContaining("code=amount_mismatch"),
    );
  });

  it("redirects to success without re-verifying on a sequential duplicate success (Test 4)", async () => {
    const { strapi, registerService } = createStrapiMock();
    const samanService = { verifyTransaction: jest.fn(), reverseTransaction: jest.fn() };
    registerService("api::payment-gateway.saman-kish", samanService);
    // A previous callback already marked this resNum's contract-transaction Success.
    (strapi.entityService.findMany as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::contract-transaction.contract-transaction") {
        return [
          {
            id: 501,
            Status: "Success",
            contract: { id: 88, order: { id: ORDER_ID } },
          },
        ];
      }
      return [];
    });

    const ctx = createCtx({
      request: { body: { State: "OK", RefNum: REF_NUM, ResNum: RES_NUM } },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(samanService.verifyTransaction).not.toHaveBeenCalled();
    expect(ctx.redirect).toHaveBeenCalledWith(
      `https://infinitycolor.co/payment/result?resultHint=success&orderId=${ORDER_ID}`,
    );
  });

  it("keeps a duplicate success idempotent when the contract-transaction hasn't flipped to Success yet (anchor-survival regression)", async () => {
    // Regression guard: settlement must never overwrite orders.external_id
    // (the resNum anchor) with refNum. If it did, a duplicate callback
    // arriving before the contract-transaction's own Status:"Success" write
    // lands (a real race — that write happens after several other awaits,
    // in a best-effort try/catch) would fail the anchor lookup and 400 a
    // customer who simply hit back/refresh, instead of hitting the
    // payment_attempts CAS idempotency path exercised below.
    const { strapi, registerService, getDbQuery } = createStrapiMock();
    const samanService = {
      verifyTransaction: jest.fn().mockResolvedValue({
        success: true,
        resultCode: 0,
        transactionDetail: { AffectiveAmount: 1500000 },
      }),
      reverseTransaction: jest.fn(),
    };
    registerService("api::payment-gateway.saman-kish", samanService);
    mockSamanAttempt(getDbQuery, { id: 66, Amount: "1500000" });

    (strapi.entityService.findMany as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return anchorOrderRow();
      if (uid === "api::contract-transaction.contract-transaction") {
        // Still Pending — the Success write from the first call hasn't
        // landed (or failed silently) by the time the duplicate arrives.
        return [{ id: 501, Status: "Pending", contract: { id: 88, order: { id: ORDER_ID } } }];
      }
      return [];
    });
    (strapi.entityService.findOne as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return baseOrderEntity();
      return null;
    });

    const body = { State: "OK", RefNum: REF_NUM, ResNum: RES_NUM };

    strapi.db.connection.raw.mockResolvedValueOnce({ rows: [{ id: 66 }] });
    const ctx1 = createCtx({ request: { body } });
    await verifyPaymentHandler(strapi as any, ctx1);

    // The duplicate: the anchor lookup must still resolve this order (it
    // would 400 here before the fix), and the CAS claim must lose because
    // the attempt is already Succeeded.
    strapi.db.connection.raw.mockResolvedValueOnce({ rows: [] });
    (strapi.entityService.findOne as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return baseOrderEntity();
      if (uid === "api::payment-attempt.payment-attempt") return { Status: "Succeeded" };
      return null;
    });
    const ctx2 = createCtx({ request: { body } });
    await verifyPaymentHandler(strapi as any, ctx2);

    expect(ctx2.badRequest).not.toHaveBeenCalled();
    expect(ctx2.redirect).toHaveBeenCalledWith(
      `https://infinitycolor.co/payment/result?resultHint=success&orderId=${ORDER_ID}`,
    );
    const startedCalls = (strapi.entityService.update as jest.Mock).mock.calls.filter(
      ([uid, id, payload]: any[]) =>
        uid === "api::order.order" && id === ORDER_ID && payload?.data?.Status === "Started",
    );
    expect(startedCalls).toHaveLength(1);
    expect(consumeOrderReservation).toHaveBeenCalledTimes(1);
  });

  it("only lets one of two concurrent duplicate Saman successes finalize the order (Test 5)", async () => {
    const { strapi, registerService, getDbQuery } = createStrapiMock();
    const samanService = {
      verifyTransaction: jest.fn().mockResolvedValue({
        success: true,
        resultCode: 0,
        transactionDetail: { AffectiveAmount: 1500000 },
      }),
      reverseTransaction: jest.fn(),
    };
    registerService("api::payment-gateway.saman-kish", samanService);
    mockSamanAttempt(getDbQuery, { id: 66, Amount: "1500000" });

    (strapi.entityService.findMany as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return anchorOrderRow();
      return [];
    });
    (strapi.entityService.findOne as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return baseOrderEntity();
      if (uid === "api::payment-attempt.payment-attempt") return { Status: "Succeeded" };
      return null;
    });
    strapi.db.connection.raw
      .mockResolvedValueOnce({ rows: [{ id: 66 }] })
      .mockResolvedValueOnce({ rows: [] });

    const body = { State: "OK", RefNum: REF_NUM, ResNum: RES_NUM };
    const ctxA = createCtx({ request: { body } });
    const ctxB = createCtx({ request: { body } });

    await Promise.all([
      verifyPaymentHandler(strapi as any, ctxA),
      verifyPaymentHandler(strapi as any, ctxB),
    ]);

    const startedCalls = (strapi.entityService.update as jest.Mock).mock.calls.filter(
      ([uid, id, payload]: any[]) =>
        uid === "api::order.order" && id === ORDER_ID && payload?.data?.Status === "Started",
    );
    expect(startedCalls).toHaveLength(1);

    // Pin the actual concurrency primitive, not just its observed effect.
    const claimSql = strapi.db.connection.raw.mock.calls
      .map(([sql]: any[]) => String(sql))
      .find((sql: string) => sql.includes("payment_attempts") && sql.includes("SET status"));
    expect(claimSql).toEqual(expect.stringContaining("status IN ('Pending', 'Redirected')"));
  });

  it("does not cancel an already-started order on a stale duplicate failure (Test 7)", async () => {
    const { strapi, registerService } = createStrapiMock();
    const samanService = { verifyTransaction: jest.fn(), reverseTransaction: jest.fn() };
    registerService("api::payment-gateway.saman-kish", samanService);
    (strapi.entityService.findMany as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return anchorOrderRow();
      return [];
    });
    (strapi.entityService.findOne as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return baseOrderEntity({ Status: "Started" });
      return null;
    });

    const ctx = createCtx({
      request: { body: { State: "FAILED", RefNum: REF_NUM, ResNum: RES_NUM } },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(strapi.entityService.update).not.toHaveBeenCalledWith(
      "api::order.order",
      ORDER_ID,
      expect.objectContaining({ data: expect.objectContaining({ Status: "Cancelled" }) }),
    );
  });

  it("does not settle when the reservation was already released before Saman could consume it (Test 9: skipped)", async () => {
    const { strapi, registerService, getDbQuery } = createStrapiMock();
    const samanService = {
      verifyTransaction: jest.fn().mockResolvedValue({
        success: true,
        resultCode: 0,
        transactionDetail: { AffectiveAmount: 1500000 },
      }),
      reverseTransaction: jest.fn().mockResolvedValue({ success: true }),
    };
    registerService("api::payment-gateway.saman-kish", samanService);
    mockSamanAttempt(getDbQuery, { id: 66, Amount: "1500000" });
    strapi.db.connection.raw.mockResolvedValue({ rows: [{ id: 66 }] });

    (strapi.entityService.findMany as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return anchorOrderRow();
      return [];
    });
    (strapi.entityService.findOne as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return baseOrderEntity();
      return null;
    });
    (consumeOrderReservation as jest.Mock).mockResolvedValueOnce({
      success: true,
      skipped: true,
      expired: false,
    });

    const ctx = createCtx({
      request: { body: { State: "OK", RefNum: REF_NUM, ResNum: RES_NUM } },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(strapi.entityService.update).not.toHaveBeenCalledWith(
      "api::order.order",
      ORDER_ID,
      expect.objectContaining({ data: expect.objectContaining({ Status: "Started" }) }),
    );
  });

  it("treats a Saman callback for an already-consumed order as an idempotent no-op (Test 10)", async () => {
    const { strapi, registerService } = createStrapiMock();
    const samanService = { verifyTransaction: jest.fn(), reverseTransaction: jest.fn() };
    registerService("api::payment-gateway.saman-kish", samanService);
    (strapi.entityService.findMany as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return anchorOrderRow();
      return [];
    });
    (strapi.entityService.findOne as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") return baseOrderEntity({ ReservationStatus: "Consumed" });
      return null;
    });

    const ctx = createCtx({
      request: { body: { State: "OK", RefNum: REF_NUM, ResNum: RES_NUM } },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(samanService.verifyTransaction).not.toHaveBeenCalled();
    expect(ctx.redirect).toHaveBeenCalledWith(
      `https://infinitycolor.co/payment/result?resultHint=success&orderId=${ORDER_ID}`,
    );
  });
});
