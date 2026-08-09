import {
  queueSnappayAdminCancel,
  queueSnappayAdminUpdate,
} from "../../payment-gateway/services/snappay-orchestrator";
import { adminAdjustItemsHandler } from "../controllers/helpers/adminAdjustItems";
import { adminCancelOrderHandler } from "../controllers/helpers/adminCancel";

jest.mock(
  "../../payment-gateway/services/snappay-orchestrator",
  () => ({
    queueSnappayAdminCancel: jest.fn(),
    queueSnappayAdminUpdate: jest.fn(),
  }),
);

const mockedCancel = queueSnappayAdminCancel as jest.MockedFunction<
  typeof queueSnappayAdminCancel
>;
const mockedUpdate = queueSnappayAdminUpdate as jest.MockedFunction<
  typeof queueSnappayAdminUpdate
>;

function snappayOrder() {
  return {
    id: 41,
    Status: "Started",
    PaymentGateway: "SnappPay",
    ShippingBarcode: null,
    ShippingCost: 20_000,
    AppliedDiscountAmount: 0,
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
          product: { product_main_category: { Title: "Category" } },
        },
      },
    ],
    contract: {
      id: 51,
      Amount: 220_000,
      Status: "Confirmed",
      external_source: "SnappPay",
      contract_transactions: [
        {
          id: 61,
          Type: "Gateway",
          Status: "Success",
          Amount: 2_200_000,
          DiscountAmount: 0,
          external_source: "SnappPay",
          TrackId: "provider-payment-token",
        },
      ],
    },
    delivery_address: null,
    shipping: null,
  };
}

function createHarness(body: Record<string, unknown>) {
  const order = snappayOrder();
  const queries: Record<string, any> = {
    "plugin::users-permissions.user": {
      findOne: jest.fn().mockResolvedValue({
        id: 7,
        role: { name: "Superadmin" },
      }),
    },
    "api::order.order": {
      findOne: jest.fn().mockResolvedValue(order),
      update: jest.fn(),
    },
  };
  const transaction = jest.fn();
  const strapi = {
    query: jest.fn((uid: string) => queries[uid]),
    db: {
      query: jest.fn((uid: string) => queries[uid]),
      transaction,
    },
    log: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
  } as any;
  const ctx = {
    params: { id: "41" },
    query: {},
    request: {
      body,
      headers: {
        "x-idempotency-key": "operator-click-1",
        "user-agent": "jest",
      },
    },
    state: { user: { id: 7 } },
    status: 200,
    badRequest: jest.fn((message, payload) => ({ message, payload })),
    badGateway: jest.fn((message, payload) => ({ message, payload })),
    conflict: jest.fn((message, payload) => ({ message, payload })),
    forbidden: jest.fn(),
    notFound: jest.fn(),
    internalServerError: jest.fn(),
  } as any;
  return { strapi, ctx, transaction };
}

describe("SnappPay admin provider operations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCancel.mockResolvedValue({ id: 101, Status: "Queued" } as any);
    mockedUpdate.mockResolvedValue({ id: 102, Status: "Queued" } as any);
  });

  it("queues cancellation and does not mutate local order or wallet inline", async () => {
    const { strapi, ctx, transaction } = createHarness({
      reason: "Customer requested cancellation",
      paymentToken: "must-not-be-trusted",
    });

    const result = await adminCancelOrderHandler(strapi, ctx);
    expect(strapi.log.error).not.toHaveBeenCalled();
    expect(ctx.forbidden).not.toHaveBeenCalled();
    expect(ctx.notFound).not.toHaveBeenCalled();
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(mockedCancel).toHaveBeenCalled();

    expect(result).toEqual({
      data: {
        success: true,
        status: "queued",
        operationId: 101,
        operationStatus: "Queued",
      },
    });
    expect(ctx.status).toBe(202);
    expect(mockedCancel).toHaveBeenCalledWith(strapi, {
      orderId: 41,
      reason: "Customer requested cancellation",
      actorId: 7,
      requestKey: "operator-click-1",
    });
    expect(mockedCancel.mock.calls[0][1]).not.toHaveProperty(
      "paymentToken",
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("requires an operator reason before queueing cancellation", async () => {
    const { strapi, ctx } = createHarness({ reason: " " });

    await adminCancelOrderHandler(strapi, ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Cancellation reason is required",
      { data: { error: "SNAPPAY_OPERATOR_REASON_REQUIRED" } },
    );
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it("returns a conflict while another irreversible provider mutation is unresolved", async () => {
    mockedCancel.mockRejectedValueOnce(
      new Error("SNAPPAY_OPERATOR_OPERATION_ACTIVE"),
    );
    const { strapi, ctx } = createHarness({
      reason: "Customer requested cancellation",
    });

    await adminCancelOrderHandler(strapi, ctx);

    expect(ctx.conflict).toHaveBeenCalledWith(
      "SnappPay order state changed",
      { data: { error: "SNAPPAY_OPERATOR_OPERATION_ACTIVE" } },
    );
  });

  it("queues a value-reducing update without provider calls in the request", async () => {
    const { strapi, ctx, transaction } = createHarness({
      items: [{ orderItemId: 71, newCount: 1 }],
      reason: "One unit unavailable",
      paymentToken: "must-not-be-trusted",
    });

    const result = await adminAdjustItemsHandler(strapi, ctx);
    expect(strapi.log.error).not.toHaveBeenCalled();
    expect(ctx.forbidden).not.toHaveBeenCalled();
    expect(ctx.notFound).not.toHaveBeenCalled();
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(mockedUpdate).toHaveBeenCalled();

    expect(result).toEqual({
      data: {
        success: true,
        status: "queued",
        operationId: 102,
        operationStatus: "Queued",
      },
    });
    expect(ctx.status).toBe(202);
    expect(mockedUpdate).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        orderId: 41,
        reason: "One unit unavailable",
        actorId: 7,
        changes: [
          {
            orderItemId: 71,
            oldCount: 2,
            newCount: 1,
            restockDelta: 1,
          },
        ],
        newTotalToman: 120_000,
        expectedOldTotalToman: 220_000,
        requestKey: "operator-click-1",
      }),
    );
    expect(mockedUpdate.mock.calls[0][1]).not.toHaveProperty(
      "paymentToken",
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects quantity increases before any durable provider operation", async () => {
    const { strapi, ctx } = createHarness({
      items: [{ orderItemId: 71, newCount: 3 }],
      reason: "Increase",
    });

    await adminAdjustItemsHandler(strapi, ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Cannot increase quantity",
      { data: { error: "invalid_count", itemId: 71 } },
    );
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCancel).not.toHaveBeenCalled();
  });
});
