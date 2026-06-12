jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, builder: any) =>
      builder({ strapi: (global as any).__paymentStatusStrapi }),
  },
}));

describe("order.checkPaymentStatus", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadController(order: any) {
    const findOne = jest.fn().mockResolvedValue(order);
    (global as any).__paymentStatusStrapi = {
      db: {
        query: jest.fn(() => ({ findOne })),
      },
    };

    const controller = require("../controllers/order").default;
    return { controller, findOne };
  }

  it("returns payment status for the authenticated owner", async () => {
    const { controller, findOne } = loadController({
      id: 60,
      Status: "Started",
      PaymentGateway: "Mellat",
      contract: { contract_transactions: [] },
    });
    const ctx = {
      params: { id: "60" },
      state: { user: { id: 10 } },
      forbidden: jest.fn(),
      badRequest: jest.fn(),
    };

    const result = await controller.checkPaymentStatus(ctx);

    expect(findOne).toHaveBeenCalledWith({
      where: { id: "60", user: { id: 10 } },
      populate: {
        contract: {
          populate: {
            contract_transactions: true,
          },
        },
      },
    });
    expect(ctx.forbidden).not.toHaveBeenCalled();
    expect(result).toEqual({
      data: {
        success: true,
        orderId: 60,
        status: "Started",
        isPaid: true,
        paymentGateway: "Mellat",
        transactionId: undefined,
      },
    });
  });

  it("forbids payment status checks for another user's order", async () => {
    const { controller } = loadController(null);
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
    expect(ctx.badRequest).not.toHaveBeenCalled();
  });
});
