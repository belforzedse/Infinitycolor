import { applySnappayAdminUpdate } from "../services/snappay-finalization";
import { enqueueRefundForReturn } from "../../report/analytics/outbox";

jest.mock("../../report/analytics/outbox", () => ({
  enqueueOrderPaid: jest.fn(),
  enqueueRefundForReturn: jest.fn().mockResolvedValue(1),
}));

const enqueueRefundMock = enqueueRefundForReturn as jest.MockedFunction<
  typeof enqueueRefundForReturn
>;

function createHarness() {
  const rows: Record<string, any> = {
    "api::payment-attempt.payment-attempt": {
      id: 11,
      Status: "Succeeded",
      providerStatus: "SETTLE",
    },
    "api::order.order": {
      id: 22,
      Status: "Started",
      ReservationStatus: "Consumed",
      ShippingBarcode: null,
      order_items: [{ id: 71, Count: 2, product_variation: { product_stock: { id: 91 } } }],
    },
    "api::contract.contract": { id: 33, Amount: 220_000 },
    "api::contract-transaction.contract-transaction": {
      id: 44,
      GatewayStatus: "SETTLE",
      TrackId: "provider-payment-token",
    },
  };
  const trx = { raw: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }) };
  const strapi = {
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    db: {
      transaction: jest.fn(async (callback: any) => callback({ trx })),
      query: jest.fn((uid: string) => ({
        findOne: jest.fn().mockResolvedValue(rows[uid]),
        findMany: jest
          .fn()
          .mockResolvedValue(
            uid === "api::contract-transaction.contract-transaction"
              ? [{ id: 44, Step: 1, Type: "Gateway" }]
              : [],
          ),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        create: jest
          .fn()
          .mockResolvedValue(
            uid === "api::contract-transaction.contract-transaction" ? { id: 777 } : {},
          ),
      })),
    },
  } as any;
  return { strapi };
}

const ids = {
  attemptId: 11,
  orderId: 22,
  contractId: 33,
  transactionRowId: 44,
  transactionId: "ABC1234567",
};

describe("applySnappayAdminUpdate -> analytics refund outbox", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    enqueueRefundMock.mockResolvedValue(1);
  });

  it("tracks a refund keyed by the new Return row id after the transaction commits", async () => {
    const { strapi } = createHarness();

    await applySnappayAdminUpdate(strapi, ids, {
      changes: [{ orderItemId: 71, oldCount: 2, newCount: 1, restockDelta: 1 }],
      newTotalToman: 110_000,
      newDiscountToman: 10_000,
      newShippingToman: 20_000,
      expectedOldTotalToman: 220_000,
      reason: "One item unavailable",
      actorId: 7,
    });

    expect(enqueueRefundMock).toHaveBeenCalledTimes(1);
    // The caller now passes IRR directly rather than toman. Same money:
    // `enqueueRefundForReturn` normalizes with `amountIrr ?? amountToman * 10`.
    expect(enqueueRefundMock).toHaveBeenCalledWith(strapi, {
      orderId: 22,
      contractTransactionId: 777,
      amountIrr: 1_100_000,
    });
  });

  it("does not track a refund when the total is unchanged (no Return row created)", async () => {
    const { strapi } = createHarness();

    await applySnappayAdminUpdate(strapi, ids, {
      changes: [{ orderItemId: 71, oldCount: 2, newCount: 2, restockDelta: 0 }],
      newTotalToman: 220_000,
      newDiscountToman: 0,
      newShippingToman: 20_000,
      expectedOldTotalToman: 220_000,
      reason: "Metadata correction",
      actorId: 7,
    });

    expect(enqueueRefundMock).not.toHaveBeenCalled();
  });
});
