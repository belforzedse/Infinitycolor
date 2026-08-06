import { adminCancelOrderHandler } from "../adminCancel";
import { adminAdjustItemsHandler } from "../adminAdjustItems";
import { trackRefundToMatomo } from "../../../../report/services/matomo-tracker";

jest.mock("../../../../report/services/matomo-tracker", () => ({
  trackOrderToMatomo: jest.fn(),
  trackRefundToMatomo: jest.fn().mockResolvedValue(true),
}));

jest.mock("../../../../../utils/adminActivity", () => ({
  logAdminOrderCancel: jest.fn(),
  logAdminOrderEdit: jest.fn(),
}));

const trackRefundMock = trackRefundToMatomo as jest.MockedFunction<typeof trackRefundToMatomo>;

function baseOrder(overrides: Record<string, any> = {}) {
  return {
    id: 41,
    Status: "Started",
    PaymentGateway: "SamanKish",
    ShippingBarcode: null,
    ShippingCost: 20_000,
    AppliedDiscountAmount: 0,
    ReservationStatus: "Consumed",
    user: { id: 9 },
    order_items: [
      {
        id: 71,
        Count: 2,
        PerAmount: 100_000,
        ProductTitle: "Product",
        product_variation: {
          id: 81,
          product_stock: { id: 91, Count: 5 },
        },
      },
    ],
    contract: {
      id: 51,
      Amount: 220_000,
      Status: "Confirmed",
      external_source: "SamanKish",
      contract_transactions: [
        {
          id: 61,
          Type: "Gateway",
          Status: "Success",
          Amount: 2_200_000, // 220,000 Toman
          external_source: "SamanKish",
        },
      ],
    },
    delivery_address: null,
    shipping: null,
    ...overrides,
  };
}

function createHarness(order: any, ctxOverrides: Record<string, any> = {}) {
  const queries: Record<string, any> = {
    "plugin::users-permissions.user": {
      findOne: jest.fn().mockResolvedValue({ id: 7, role: { name: "Store manager" } }),
    },
    "api::order.order": {
      findOne: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue({}),
    },
    "api::product-stock.product-stock": {
      findOne: jest.fn().mockResolvedValue({ id: 91, Count: 5 }),
      update: jest.fn().mockResolvedValue({}),
    },
    "api::contract.contract": {
      update: jest.fn().mockResolvedValue({}),
    },
    "api::local-user-wallet.local-user-wallet": {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 501, Balance: 0 }),
      update: jest.fn().mockResolvedValue({}),
    },
    "api::local-user-wallet-transaction.local-user-wallet-transaction": {
      create: jest.fn().mockResolvedValue({}),
    },
    "api::contract-transaction.contract-transaction": {
      create: jest.fn().mockResolvedValue({ id: 999 }),
    },
    "api::order-log.order-log": {
      create: jest.fn().mockResolvedValue({}),
    },
    "api::order-item.order-item": {
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const strapi = {
    db: {
      query: jest.fn((uid: string) => queries[uid]),
      transaction: jest.fn(async (callback: any) => callback({})),
    },
    log: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
  } as any;
  const ctx = {
    params: { id: "41" },
    query: {},
    request: { body: {}, headers: {} },
    state: { user: { id: 7 } },
    status: 200,
    badRequest: jest.fn((message, payload) => ({ message, payload })),
    conflict: jest.fn((message, payload) => ({ message, payload })),
    forbidden: jest.fn(),
    notFound: jest.fn(),
    internalServerError: jest.fn(),
    ...ctxOverrides,
  } as any;
  return { strapi, ctx, queries };
}

describe("Admin refund -> Matomo tracking", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    trackRefundMock.mockResolvedValue(true);
  });

  it("adminCancelOrderHandler tracks a refund after the transaction commits, keyed by the Return row id", async () => {
    const order = baseOrder();
    const { strapi, ctx } = createHarness(order);

    const result = await adminCancelOrderHandler(strapi, ctx);

    expect(result).toEqual({
      data: { success: true, refundToman: 220_000, status: "cancelled" },
    });
    expect(trackRefundMock).toHaveBeenCalledTimes(1);
    expect(trackRefundMock).toHaveBeenCalledWith(strapi, {
      orderId: 41,
      contractTransactionId: 999,
      amountToman: 220_000,
      userId: 9,
    });
  });

  it("adminCancelOrderHandler does not track a refund when nothing was paid", async () => {
    const order = baseOrder({
      contract: {
        id: 51,
        Amount: 0,
        Status: "Confirmed",
        external_source: "SamanKish",
        contract_transactions: [],
      },
    });
    const { strapi, ctx } = createHarness(order);

    await adminCancelOrderHandler(strapi, ctx);

    expect(trackRefundMock).not.toHaveBeenCalled();
  });

  it("adminAdjustItemsHandler tracks a refund sized to the adjustment, after commit", async () => {
    const order = baseOrder({
      order_items: [
        {
          id: 71,
          Count: 2,
          PerAmount: 100_000,
          ProductTitle: "Product",
          product_variation: {
            id: 81,
            product_stock: { id: 91, Count: 5 },
          },
        },
      ],
    });
    const { strapi, ctx } = createHarness(order, {
      request: {
        body: {
          items: [{ orderItemId: 71, newCount: 1 }],
          reason: "Customer requested partial refund",
        },
        headers: {},
      },
    });

    const result: any = await adminAdjustItemsHandler(strapi, ctx);

    expect(result.data.success).toBe(true);
    expect(trackRefundMock).toHaveBeenCalledTimes(1);
    const call = trackRefundMock.mock.calls[0][1];
    expect(call.orderId).toBe(41);
    expect(call.contractTransactionId).toBe(999);
    expect(call.amountToman).toBe(result.data.refundToman);
    expect(call.amountToman).toBeGreaterThan(0);
  });

  it("does not fail the request if Matomo refund tracking rejects", async () => {
    trackRefundMock.mockRejectedValue(new Error("matomo down"));
    const order = baseOrder();
    const { strapi, ctx } = createHarness(order);

    const result = await adminCancelOrderHandler(strapi, ctx);

    expect(result).toEqual({
      data: { success: true, refundToman: 220_000, status: "cancelled" },
    });
  });
});
