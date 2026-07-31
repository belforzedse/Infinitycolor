jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, builder: any) =>
      builder({ strapi: (global as any).__paymentStatusStrapi }),
    createCoreService: jest.fn(() => ({})),
  },
}));

describe("order.checkPaymentStatus", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadController(order: any, attempt: any = null) {
    const orderFindOne = jest.fn().mockResolvedValue(order);
    const attemptFindOne = jest.fn().mockResolvedValue(attempt);
    const attemptUpdate = jest.fn().mockImplementation(async ({ data }: any) => data);
    (global as any).__paymentStatusStrapi = {
      db: {
        query: jest.fn((uid: string) => {
          if (uid === "api::order.order") return { findOne: orderFindOne };
          if (uid === "api::payment-attempt.payment-attempt") {
            return { findOne: attemptFindOne, update: attemptUpdate };
          }
          return { findOne: jest.fn(), update: jest.fn() };
        }),
      },
    };

    const controller = require("../controllers/order").default;
    return { controller, orderFindOne, attemptFindOne, attemptUpdate };
  }

  it("reconciles a paid order and returns an authoritative customer result", async () => {
    const { controller, orderFindOne, attemptFindOne, attemptUpdate } = loadController(
      {
        id: 60,
        Status: "Started",
        PaymentGateway: "Mellat",
        contract: { contract_transactions: [] },
      },
      {
        id: 90,
        attemptId: "attempt-60",
        Status: "Redirected",
        Amount: 1_500_000,
        providerReference: "bank-ref-60",
      },
    );
    const ctx = {
      params: { id: "60" },
      state: { user: { id: 10 } },
      forbidden: jest.fn(),
      badRequest: jest.fn(),
    };

    const result = await controller.checkPaymentStatus(ctx);

    expect(orderFindOne).toHaveBeenCalledWith({
      where: { id: "60", user: { id: 10 } },
      populate: {
        contract: {
          populate: {
            contract_transactions: { populate: { payment_gateway: true } },
          },
        },
      },
    });
    expect(attemptFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { order: { id: 60 } } }),
    );
    expect(attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 90 },
        data: expect.objectContaining({ Status: "Succeeded" }),
      }),
    );
    expect(result).toEqual({
      data: expect.objectContaining({
        success: true,
        orderId: 60,
        status: "Started",
        paymentStatus: "Succeeded",
        isPaid: true,
        paymentGateway: "Mellat",
        transactionId: "bank-ref-60",
        attemptId: "attempt-60",
        amountIrr: 1_500_000,
        canRetry: false,
        nextAction: "view_order",
        authoritative: true,
      }),
    });
  });

  it("keeps a recent redirected payment ambiguous and tells the customer to recheck", async () => {
    const { controller, attemptUpdate } = loadController(
      {
        id: 61,
        Status: "Paying",
        PaymentGateway: "SamanKish",
        contract: { contract_transactions: [] },
      },
      {
        id: 91,
        attemptId: "attempt-61",
        Status: "Redirected",
        redirectedAt: new Date(),
      },
    );
    const ctx = {
      params: { id: "61" },
      state: { user: { id: 10 } },
      forbidden: jest.fn(),
      badRequest: jest.fn(),
    };

    const result = await controller.checkPaymentStatus(ctx);

    expect(result.data).toEqual(
      expect.objectContaining({
        paymentStatus: "Redirected",
        isPaid: false,
        canRetry: false,
        nextAction: "recheck",
        authoritative: true,
      }),
    );
    expect(attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ Status: "Redirected" }),
      }),
    );
  });

  it("fails closed when a legacy SnappPay order has no authoritative attempt", async () => {
    const { controller, attemptFindOne, attemptUpdate } = loadController({
      id: 62,
      Status: "Started",
      PaymentGateway: "SnappPay",
      contract: {
        external_id: "snapp-transaction-62",
        contract_transactions: [],
      },
    });
    const ctx = {
      params: { id: "62" },
      state: { user: { id: 10 } },
      forbidden: jest.fn(),
      badRequest: jest.fn(),
    };

    const result = await controller.checkPaymentStatus(ctx);

    expect(attemptFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { order: { id: 62 } } }),
    );
    expect(attemptUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({
      data: {
        success: true,
        orderId: 62,
        status: "Started",
        paymentStatus: "Unknown",
        isPaid: false,
        paymentGateway: "SnappPay",
        transactionId: "snapp-transaction-62",
        attemptId: undefined,
        amountIrr: undefined,
        canRetry: false,
        nextAction: "recheck",
        failureCode: "SNAPPAY_ATTEMPT_NOT_FOUND",
        failureMessage: "SnappPay payment requires reconciliation",
        lastReconciledAt: undefined,
        authoritative: false,
      },
    });
  });

  it("forbids payment status checks for another user's order", async () => {
    const { controller, attemptFindOne } = loadController(null);
    const ctx = {
      params: { id: "60" },
      state: { user: { id: 10 } },
      forbidden: jest.fn(),
      badRequest: jest.fn(),
    };

    const result = await controller.checkPaymentStatus(ctx);

    expect(result).toBeUndefined();
    expect(ctx.forbidden).toHaveBeenCalledWith(
      "You do not have permission to access this order",
      {
        data: {
          success: false,
          error: "You do not have permission to access this order",
        },
      },
    );
    expect(attemptFindOne).not.toHaveBeenCalled();
    expect(ctx.badRequest).not.toHaveBeenCalled();
  });
});
