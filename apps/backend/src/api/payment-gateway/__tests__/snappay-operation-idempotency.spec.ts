import { enqueueSnappayOperation } from "../../../queue/snappay";
import { queueSnappayAdminUpdate } from "../services/snappay-orchestrator";

jest.mock("../../../queue/snappay", () => ({
  enqueueSnappayOperation: jest.fn().mockResolvedValue(undefined),
}));

const mockedEnqueue = enqueueSnappayOperation as jest.MockedFunction<
  typeof enqueueSnappayOperation
>;

describe("SnappPay durable operation idempotency", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reuses the same update operation for a repeated operator request", async () => {
    const attempt = {
      id: 11,
      attemptId: "attempt-11",
      Status: "Succeeded",
      Gateway: "snappay",
      providerStatus: "SETTLE",
      providerReference: "ABC1234567",
      order: {
        id: 22,
        Status: "Started",
        ShippingBarcode: null,
        user: { id: 5 },
        order_items: [],
      },
      contract: {
        id: 33,
        contract_transactions: [
          {
            id: 44,
            external_source: "SnappPay",
            external_id: "ABC1234567",
          },
        ],
      },
    };
    let storedOperation: any = null;
    const operationQuery = {
      findOne: jest.fn().mockImplementation(() => storedOperation),
      create: jest.fn().mockImplementation(({ data }) => {
        storedOperation = { id: 55, retryCount: 0, ...data };
        return storedOperation;
      }),
      update: jest.fn(),
    };
    const attemptQuery = {
      findOne: jest.fn().mockResolvedValue(attempt),
      update: jest.fn(),
    };
    const strapi = {
      db: {
        query: jest.fn((uid: string) =>
          uid === "api::payment-operation.payment-operation" ? operationQuery : attemptQuery,
        ),
        transaction: jest.fn(async (callback) =>
          callback({ trx: { raw: jest.fn().mockResolvedValue({ rows: [] }) } }),
        ),
      },
      log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    } as any;
    const input = {
      orderId: 22,
      reason: "One unit unavailable",
      actorId: 7,
      requestKey: "click-1",
      changes: [
        {
          orderItemId: 71,
          oldCount: 2,
          newCount: 1,
          restockDelta: 1,
        },
      ],
      newTotalToman: 120_000,
      newDiscountToman: 0,
      newShippingToman: 20_000,
      expectedOldTotalToman: 220_000,
    };

    const first = await queueSnappayAdminUpdate(strapi, input);
    const second = await queueSnappayAdminUpdate(strapi, input);

    expect(first.id).toBe(55);
    expect(second.id).toBe(55);
    expect(operationQuery.create).toHaveBeenCalledTimes(1);
    expect(mockedEnqueue).toHaveBeenCalledTimes(1);
    expect(strapi.db.transaction).toHaveBeenCalledTimes(1);
    expect(storedOperation.idempotencyKey).toMatch(/^update:11:/);
    expect(storedOperation.metadata).toEqual(
      expect.objectContaining({
        operatorAction: true,
        reason: "One unit unavailable",
      }),
    );
  });

  it("serializes different operator mutations on the payment attempt row", async () => {
    const attempt = {
      id: 11,
      attemptId: "attempt-11",
      Status: "Succeeded",
      Gateway: "snappay",
      providerStatus: "SETTLE",
      providerReference: "ABC1234567",
      order: {
        id: 22,
        Status: "Started",
        ShippingBarcode: null,
        user: { id: 5 },
        order_items: [],
      },
      contract: {
        id: 33,
        contract_transactions: [
          {
            id: 44,
            external_source: "SnappPay",
            external_id: "ABC1234567",
          },
        ],
      },
    };
    const activeOperation = {
      id: 54,
      idempotencyKey: "cancel:11:previous",
      OperationType: "CANCEL",
      Status: "Unknown",
    };
    const operationQuery = {
      findOne: jest.fn().mockImplementation(({ where }) => {
        if (where.idempotencyKey) return null;
        if (where.attemptKey) return activeOperation;
        return null;
      }),
      create: jest.fn(),
      update: jest.fn(),
    };
    const attemptQuery = {
      findOne: jest.fn().mockResolvedValue(attempt),
      update: jest.fn(),
    };
    const raw = jest.fn().mockResolvedValue({ rows: [{ id: 11 }] });
    const strapi = {
      db: {
        query: jest.fn((uid: string) =>
          uid === "api::payment-operation.payment-operation" ? operationQuery : attemptQuery,
        ),
        transaction: jest.fn(async (callback) => callback({ trx: { raw } })),
      },
      log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    } as any;

    await expect(
      queueSnappayAdminUpdate(strapi, {
        orderId: 22,
        reason: "One unit unavailable",
        actorId: 7,
        requestKey: "click-2",
        changes: [
          {
            orderItemId: 71,
            oldCount: 2,
            newCount: 1,
            restockDelta: 1,
          },
        ],
        newTotalToman: 120_000,
        newDiscountToman: 0,
        newShippingToman: 20_000,
        expectedOldTotalToman: 220_000,
      }),
    ).rejects.toThrow("SNAPPAY_OPERATOR_OPERATION_ACTIVE");

    expect(raw).toHaveBeenCalledWith("SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE", [
      11,
    ]);
    expect(operationQuery.create).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });
});
