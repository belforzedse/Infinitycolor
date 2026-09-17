import { queueSnappayAdminCancel } from "../services/snappay-orchestrator";

jest.mock("../../../queue/snappay", () => ({
  enqueueSnappayOperation: jest.fn().mockResolvedValue(undefined),
}));

function settledAttempt(order: {
  Status: string;
  ShippingBarcode?: string | null;
}) {
  return {
    id: 11,
    Status: "Succeeded",
    providerStatus: "SETTLE",
    providerReference: "tok-111786",
    Gateway: "snappay",
    order: {
      id: 111786,
      Status: order.Status,
      ShippingBarcode: order.ShippingBarcode ?? null,
    },
    contract: {
      id: 33,
      contract_transactions: [
        {
          id: 44,
          external_source: "SnappPay",
          external_id: "tok-111786",
        },
      ],
    },
  };
}

function createStrapi(attempt: ReturnType<typeof settledAttempt>) {
  const created = { id: 101, Status: "Queued", retryCount: 0 };
  const operationQuery = {
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue(created),
    create: jest.fn().mockResolvedValue(created),
  };
  const attemptQuery = {
    findOne: jest.fn().mockResolvedValue(attempt),
    update: jest.fn().mockResolvedValue(attempt),
  };
  const strapi = {
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    db: {
      transaction: jest.fn(async (callback: (args: { trx: { raw: jest.Mock } }) => unknown) =>
        callback({ trx: { raw: jest.fn().mockResolvedValue({ rows: [{ id: 11 }] }) } }),
      ),
      query: jest.fn((uid: string) => {
        if (uid === "api::payment-operation.payment-operation") return operationQuery;
        return attemptQuery;
      }),
    },
  };
  return { strapi, operationQuery };
}

describe("queueSnappayAdminCancel fulfilment guard", () => {
  const input = {
    orderId: 111786,
    reason: "محصول زدگی داشت مشتری منصرف شد",
    actorId: 7,
  };

  it.each([
    ["Shipment", null],
    ["Shipment", "ANIPO-1"],
    ["Done", null],
  ] as const)(
    "queues cancel for a settled %s order with barcode %s",
    async (status, barcode) => {
      const { strapi, operationQuery } = createStrapi(
        settledAttempt({ Status: status, ShippingBarcode: barcode }),
      );

      await expect(queueSnappayAdminCancel(strapi as never, input)).resolves.toEqual(
        expect.objectContaining({ id: 101, Status: "Queued" }),
      );
      expect(operationQuery.create).toHaveBeenCalled();
    },
  );

  it("still refuses cancel once the order is Returned", async () => {
    const { strapi, operationQuery } = createStrapi(
      settledAttempt({ Status: "Returned" }),
    );

    await expect(queueSnappayAdminCancel(strapi as never, input)).rejects.toThrow(
      "SNAPPAY_OPERATOR_STATE_INVALID",
    );
    expect(operationQuery.create).not.toHaveBeenCalled();
  });

  it("still refuses item-update on a Shipment order with a barcode", async () => {
    const { queueSnappayAdminUpdate } = await import("../services/snappay-orchestrator");
    const { strapi, operationQuery } = createStrapi(
      settledAttempt({ Status: "Shipment", ShippingBarcode: "ANIPO-1" }),
    );

    await expect(
      queueSnappayAdminUpdate(strapi as never, {
        orderId: 111786,
        reason: "کمبود موجودی",
        actorId: 7,
        changes: [
          { orderItemId: 1, oldCount: 2, newCount: 1, restockDelta: 1 },
        ],
        newTotalToman: 100_000,
        newDiscountToman: 0,
        newShippingToman: 0,
        expectedOldTotalToman: 200_000,
      }),
    ).rejects.toThrow("SNAPPAY_OPERATOR_STATE_INVALID");
    expect(operationQuery.create).not.toHaveBeenCalled();
  });
});
