import { verifyPaymentHandler } from "../../order/controllers/helpers/payment";
import { hashSnappayCallbackNonce } from "../services/snappay-security";

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

/** 22 base64url chars, matching isValidSnappayCallbackNonce. */
const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";
const ORDER_ID = 113678;

const originalFrontendBaseUrl = process.env.FRONTEND_BASE_URL;

const createGetCtx = () => ({
  request: {
    method: "GET",
    ip: "127.0.0.1",
    header: { "user-agent": "jest" },
    body: {},
    query: { nonce: NONCE },
  },
  method: "GET",
  badRequest: jest.fn(),
  redirect: jest.fn(),
});

const createStrapiMock = (attemptRow: any) => {
  const reconcileOrder = jest.fn().mockResolvedValue(undefined);
  const attemptFindOne = jest.fn().mockResolvedValue(attemptRow);
  const strapi: any = {
    log: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
    entityService: {
      findOne: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    service: jest.fn((uid: string) =>
      uid === "api::payment-gateway.snappay-orchestrator" ? { reconcileOrder } : undefined,
    ),
    db: {
      query: jest.fn((uid: string) =>
        uid === "api::payment-attempt.payment-attempt"
          ? { findOne: attemptFindOne }
          : { findOne: jest.fn(), create: jest.fn(), update: jest.fn() },
      ),
      connection: { raw: jest.fn().mockResolvedValue({ rows: [] }) },
    },
  };
  return { strapi, reconcileOrder, attemptFindOne };
};

describe("SnappPay bare-GET return correlated by nonce", () => {
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

  it("looks the attempt up by the hashed nonce, not the raw value", async () => {
    const { strapi, attemptFindOne } = createStrapiMock({
      id: 2244,
      order: { id: ORDER_ID },
    });
    const ctx = createGetCtx();

    await verifyPaymentHandler(strapi, ctx as any);

    expect(attemptFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          Gateway: "snappay",
          callbackNonceHash: hashSnappayCallbackNonce(NONCE),
        },
      }),
    );
  });

  it("reconciles the order and sends the result page an orderId it can poll", async () => {
    const { strapi, reconcileOrder } = createStrapiMock({
      id: 2244,
      order: { id: ORDER_ID },
    });
    const ctx = createGetCtx();

    await verifyPaymentHandler(strapi, ctx as any);

    expect(reconcileOrder).toHaveBeenCalledWith(ORDER_ID, "return_without_result");
    const redirected = String((ctx.redirect as jest.Mock).mock.calls[0][0]);
    expect(redirected).toContain(`orderId=${ORDER_ID}`);
    expect(redirected).toContain("code=return_without_result");
    expect(redirected).not.toContain("uncorrelated_callback");
  });

  it("never treats the bare GET as a payment result", async () => {
    const { strapi } = createStrapiMock({ id: 2244, order: { id: ORDER_ID } });
    const ctx = createGetCtx();

    await verifyPaymentHandler(strapi, ctx as any);

    // No settlement, no success hint — provider state comes only from GET /status.
    const redirected = String((ctx.redirect as jest.Mock).mock.calls[0][0]);
    expect(redirected).not.toContain("resultHint=success");
    expect(strapi.entityService.update).not.toHaveBeenCalled();
  });

  it("falls through to uncorrelated when the nonce matches no attempt", async () => {
    const { strapi, reconcileOrder } = createStrapiMock(null);
    const ctx = createGetCtx();

    await verifyPaymentHandler(strapi, ctx as any);

    expect(reconcileOrder).not.toHaveBeenCalled();
    expect(String((ctx.redirect as jest.Mock).mock.calls[0][0])).toContain(
      "uncorrelated_callback",
    );
  });

  it("does not correlate a malformed nonce", async () => {
    const { strapi, reconcileOrder, attemptFindOne } = createStrapiMock({
      id: 2244,
      order: { id: ORDER_ID },
    });
    const ctx = createGetCtx();
    ctx.request.query = { nonce: "too-short" };

    await verifyPaymentHandler(strapi, ctx as any);

    expect(attemptFindOne).not.toHaveBeenCalled();
    expect(reconcileOrder).not.toHaveBeenCalled();
    expect(String((ctx.redirect as jest.Mock).mock.calls[0][0])).toContain(
      "uncorrelated_callback",
    );
  });

  it("still redirects the customer when the reconcile enqueue throws", async () => {
    const { strapi, reconcileOrder } = createStrapiMock({
      id: 2244,
      order: { id: ORDER_ID },
    });
    reconcileOrder.mockRejectedValue(new Error("queue down"));
    const ctx = createGetCtx();

    await verifyPaymentHandler(strapi, ctx as any);

    expect(ctx.redirect).toHaveBeenCalled();
    expect(String((ctx.redirect as jest.Mock).mock.calls[0][0])).toContain(
      `orderId=${ORDER_ID}`,
    );
  });
});
