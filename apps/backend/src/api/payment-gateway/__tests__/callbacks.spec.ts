import { acceptMellatCallback } from "../services/mellat-coordinator";
jest.mock("../services/mellat-coordinator", () => ({ acceptMellatCallback: jest.fn() }));
import * as Sentry from "@sentry/node";
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

jest.mock("@sentry/node", () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

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

  it("persists Mellat evidence through the coordinator and redirects to authoritative pending status", async () => {
    const { strapi } = createStrapiMock();
    const body = { ResCode: "0", RefId: "ExactRef", SaleOrderId: "200", SaleReferenceId: "9007199254740993" };
    (acceptMellatCallback as jest.Mock).mockResolvedValueOnce({ orderId: 200, status: "Unknown", attemptId: 12 });
    const ctx = createCtx({ request: { method: "POST", body } });
    await verifyPaymentHandler(strapi, ctx);
    expect(acceptMellatCallback).toHaveBeenCalledWith(strapi, body);
    expect(ctx.redirect).toHaveBeenCalledWith("https://infinitycolor.co/payment/result?resultHint=issue&orderId=200&code=payment_pending");
    expect(strapi.entityService.update).not.toHaveBeenCalled();
    expect(consumeOrderReservation).not.toHaveBeenCalled();
  });

  it("returns the paid result for an already-settled Mellat attempt", async () => {
    const { strapi } = createStrapiMock();
    (acceptMellatCallback as jest.Mock).mockResolvedValueOnce({ orderId: 200, status: "Succeeded", attemptId: 12 });
    const ctx = createCtx({ request: { method: "POST", body: { ResCode: "0", RefId: "ExactRef", SaleOrderId: "200", SaleReferenceId: "123" } } });
    await verifyPaymentHandler(strapi, ctx);
    expect(ctx.redirect).toHaveBeenCalledWith("https://infinitycolor.co/payment/result?resultHint=success&orderId=200");
    expect(consumeOrderReservation).not.toHaveBeenCalled();
  });

  it.each(["MELLAT_CALLBACK_INVALID", "MELLAT_CALLBACK_UNCORRELATED", "MELLAT_CALLBACK_REFERENCE_MISMATCH", "MELLAT_CALLBACK_REFERENCE_MISSING"])(
    "rejects %s without a provider call or order mutation", async (reason) => {
      const { strapi } = createStrapiMock();
      (acceptMellatCallback as jest.Mock).mockRejectedValueOnce(new Error(reason));
      const ctx = createCtx({ request: { method: "POST", body: { ResCode: "0", RefId: "ExactRef" } } });
      await verifyPaymentHandler(strapi, ctx);
      expect(ctx.badRequest).toHaveBeenCalledWith("Invalid payment reference");
      expect(strapi.entityService.update).not.toHaveBeenCalled();
      expect(consumeOrderReservation).not.toHaveBeenCalled();
    },
  );

  it("does not interpret an empty GET as a Mellat failure", async () => {
    const { strapi } = createStrapiMock();
    const ctx = createCtx({ request: { method: "GET", body: {}, query: {} } });
    await verifyPaymentHandler(strapi, ctx);
    expect(acceptMellatCallback).not.toHaveBeenCalled();
    expect(strapi.entityService.update).not.toHaveBeenCalled();
  });

  it("routes SnappPay input on the shared callback endpoint through the hardened handler", async () => {
    const { strapi, registerService } = createStrapiMock();
    const legacyService = {
      status: jest.fn(),
      verify: jest.fn(),
      settle: jest.fn(),
      revert: jest.fn(),
    };
    registerService("api::payment-gateway.snappay", legacyService);
    const acceptCallback = jest.fn().mockResolvedValue({
      accepted: true,
      redirectUrl: "https://infinitycolor.co/payment/result?resultHint=processing",
    });
    registerService("api::payment-gateway.snappay-orchestrator", { acceptCallback });
    const ctx = createCtx({
      request: {
        method: "POST",
        body: {
          state: "OK",
          transactionId: "ABC1234567",
          amount: "1200000",
          paymentToken: "must-not-be-accepted",
          OrderId: "700",
        },
        query: { nonce: "abcdefghijklmnopqrstuv" },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(acceptCallback).toHaveBeenCalledWith({
      transactionId: "ABC1234567",
      state: "OK",
      amount: 1_200_000,
      nonce: "abcdefghijklmnopqrstuv",
    });
    expect(acceptCallback.mock.calls[0][0]).not.toHaveProperty("paymentToken");
    expect(acceptCallback.mock.calls[0][0]).not.toHaveProperty("OrderId");
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=processing",
    );
    expect(ctx.status).toBe(303);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(legacyService.status).not.toHaveBeenCalled();
    expect(legacyService.verify).not.toHaveBeenCalled();
    expect(legacyService.settle).not.toHaveBeenCalled();
    expect(legacyService.revert).not.toHaveBeenCalled();
    expect(decrementStockAtomic).not.toHaveBeenCalled();
  });

  it("keeps nonce-less legacy SnappPay input disabled on the shared callback endpoint", async () => {
    const { strapi, registerService } = createStrapiMock();
    const legacyService = {
      status: jest.fn(),
      verify: jest.fn(),
      settle: jest.fn(),
      revert: jest.fn(),
    };
    registerService("api::payment-gateway.snappay", legacyService);
    const acceptCallback = jest.fn();
    registerService("api::payment-gateway.snappay-orchestrator", { acceptCallback });
    const ctx = createCtx({
      request: {
        body: {
          state: "OK",
          transactionId: "ABC1234567",
          amount: "1200000",
          paymentToken: "must-not-be-accepted",
          OrderId: "700",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith("SnappPay callback endpoint has changed", {
      data: {
        success: false,
        errorCode: "SNAPPAY_LEGACY_CALLBACK_DISABLED",
      },
    });
    expect(acceptCallback).not.toHaveBeenCalled();
    expect(legacyService.status).not.toHaveBeenCalled();
    expect(legacyService.verify).not.toHaveBeenCalled();
    expect(legacyService.settle).not.toHaveBeenCalled();
    expect(legacyService.revert).not.toHaveBeenCalled();
    expect(decrementStockAtomic).not.toHaveBeenCalled();
  });

  it("does not route GET requests with SnappPay-shaped query data through the POST callback", async () => {
    const { strapi, registerService } = createStrapiMock();
    const acceptCallback = jest.fn();
    registerService("api::payment-gateway.snappay-orchestrator", { acceptCallback });
    const ctx = createCtx({
      request: {
        method: "GET",
        body: {
          state: "OK",
          transactionId: "ABC1234567",
          amount: "1200000",
        },
        query: { nonce: "abcdefghijklmnopqrstuv" },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(acceptCallback).not.toHaveBeenCalled();
    expect(ctx.badRequest).toHaveBeenCalledWith("SnappPay callback endpoint has changed", {
      data: {
        success: false,
        errorCode: "SNAPPAY_LEGACY_CALLBACK_DISABLED",
      },
    });
  });

  it("fails a malformed correlated SnappPay callback through the hardened handler", async () => {
    const { strapi, registerService } = createStrapiMock();
    const acceptCallback = jest.fn().mockResolvedValue({
      accepted: false,
      redirectUrl: "https://infinitycolor.co/payment/result?resultHint=invalid_callback",
    });
    registerService("api::payment-gateway.snappay-orchestrator", { acceptCallback });
    const ctx = createCtx({
      request: {
        method: "POST",
        body: {
          state: "UNKNOWN",
          transactionId: "not-valid",
          amount: "0",
        },
        query: { nonce: "bad" },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(acceptCallback).toHaveBeenCalledWith({
      transactionId: "not-valid",
      state: "UNKNOWN",
      amount: 0,
      nonce: "bad",
    });
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/result?resultHint=invalid_callback",
    );
    expect(ctx.status).toBe(303);
    expect(ctx.badRequest).not.toHaveBeenCalled();
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
          CancellationReason: "پرداخت توسط درگاه تایید نشد",
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
        // contract_transactions.Amount is IRR; the contract's own Amount is
        // toman. The fixture previously used the toman figure for both, which
        // masked the fact that verification must use the amount the gateway was
        // actually asked for — the gateway leg recorded on this row.
        Amount: 250_000,
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
