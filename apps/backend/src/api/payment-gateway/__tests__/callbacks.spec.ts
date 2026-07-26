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
  consumeOrderReservation: jest.fn().mockResolvedValue({ success: true }),
  releaseOrderReservation: jest.fn().mockResolvedValue({ success: true }),
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
    const { strapi } = createStrapiMock();
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
      "https://infinitycolor.co/payment/cancelled?orderId=100&reason=user-cancelled",
    );
  });

  it("settles a successful Mellat callback and decrements stock", async () => {
    const { strapi, registerService } = createStrapiMock();
    const mellatService = {
      verifyTransaction: jest.fn().mockResolvedValue({ success: true }),
      settleTransaction: jest.fn().mockResolvedValue({
        success: true,
        resCode: 0,
      }),
    };
    registerService("api::payment-gateway.mellat-v3", mellatService);

    const orderWithItems = {
      id: 200,
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

    expect(decrementStockAtomic).toHaveBeenCalledWith(strapi, 5, 2);
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
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/success?orderId=200",
    );
  });

  it("rejects SnappPay callback without a payment token", async () => {
    const { strapi, registerService } = createStrapiMock();
    registerService("api::payment-gateway.snappay", {
      verify: jest.fn(),
      settle: jest.fn(),
      revert: jest.fn(),
    });

    (strapi.entityService.findMany as jest.Mock).mockImplementation(
      async (uid: string, params: any) => {
        if (
          uid === "api::contract-transaction.contract-transaction" &&
          params.filters?.contract
        ) {
          return [];
        }
        return [];
      },
    );

    const ctx = createCtx({
      request: {
        body: {
          state: "OK",
          transactionId: "SN-1",
          OrderId: "600",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Missing payment token for SnappPay",
      expect.objectContaining({
        data: expect.objectContaining({ error: "Missing paymentToken" }),
      }),
    );
  });

  it("verifies and settles a SnappPay callback successfully", async () => {
    const { strapi, registerService } = createStrapiMock();
    const snappayService = {
      status: jest
        .fn()
        .mockResolvedValueOnce({
          successful: true,
          response: { status: "VERIFY_PENDING", transactionId: "SN-OK" },
        })
        .mockResolvedValueOnce({
          successful: true,
          response: { status: "SETTLED", transactionId: "SN-OK" },
        }),
      verify: jest.fn().mockResolvedValue({ successful: true }),
      settle: jest.fn().mockResolvedValue({ successful: true }),
      revert: jest.fn(),
    };
    registerService("api::payment-gateway.snappay", snappayService);

    (strapi.entityService.findOne as jest.Mock).mockImplementation(
      async (uid: string) => {
        if (uid === "api::order.order") {
          return {
            id: 700,
            order_items: [
              {
                Count: 1,
                product_variation: {
                  product_stock: { id: 301, Count: 5 },
                },
              },
            ],
          };
        }
        return null;
      },
    );

    const ctx = createCtx({
      request: {
        body: {
          OrderId: "700",
          state: "OK",
          transactionId: "SN-OK",
          paymentToken: "PT-OK",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(snappayService.status).toHaveBeenCalledTimes(2);
    expect(snappayService.verify).toHaveBeenCalledWith("PT-OK");
    expect(snappayService.settle).toHaveBeenCalledWith("PT-OK");

    expect(decrementStockAtomic).toHaveBeenCalledWith(strapi, 301, 1);
    expect(strapi.entityService.update).toHaveBeenCalledWith(
      "api::order.order",
      700,
      { data: { Status: "Started" } },
    );
    expect(strapi.entityService.create).toHaveBeenCalledWith(
      "api::order-log.order-log",
      expect.objectContaining({
        data: expect.objectContaining({
          order: 700,
          Description: expect.stringContaining("SnappPay verify+settle succeeded"),
        }),
      }),
    );
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/success?orderId=700&transactionId=SN-OK",
    );
  });

  it("uses status fallback when SnappPay verify fails but status is VERIFY", async () => {
    const { strapi, registerService } = createStrapiMock();
    const snappayService = {
      status: jest
        .fn()
        .mockResolvedValueOnce({
          successful: true,
          response: { status: "VERIFY_PENDING", transactionId: "SN-FB" },
        })
        .mockResolvedValueOnce({
          successful: true,
          response: { status: "VERIFY", transactionId: "SN-FB" },
        })
        .mockResolvedValueOnce({
          successful: true,
          response: { status: "SETTLED", transactionId: "SN-FB" },
        }),
      verify: jest.fn().mockResolvedValue({
        successful: false,
        errorData: { message: "timeout" },
      }),
      settle: jest.fn().mockResolvedValue({ successful: true }),
      revert: jest.fn(),
    };
    registerService("api::payment-gateway.snappay", snappayService);

    (strapi.entityService.findOne as jest.Mock).mockImplementation(async (uid: string) => {
      if (uid === "api::order.order") {
        return {
          id: 701,
          order_items: [
            {
              Count: 1,
              product_variation: {
                product_stock: { id: 302, Count: 5 },
              },
            },
          ],
        };
      }
      return null;
    });

    const ctx = createCtx({
      request: {
        body: {
          OrderId: "701",
          state: "OK",
          transactionId: "SN-FB",
          paymentToken: "PT-FB",
        },
      },
    });

    await verifyPaymentHandler(strapi as any, ctx);

    expect(snappayService.verify).toHaveBeenCalledWith("PT-FB");
    expect(snappayService.settle).toHaveBeenCalledWith("PT-FB");
    expect(snappayService.status).toHaveBeenCalledTimes(3);
    expect(strapi.entityService.update).toHaveBeenCalledWith(
      "api::order.order",
      701,
      { data: { Status: "Started" } },
    );
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://infinitycolor.co/payment/success?orderId=701&transactionId=SN-FB",
    );
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
    (strapi.entityService.findOne as jest.Mock).mockResolvedValueOnce({
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
    (strapi.entityService.findOne as jest.Mock).mockResolvedValueOnce({
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
