import { applySnappayAdminUpdate } from "../services/snappay-finalization";

function createHarness() {
  const updates: Record<string, jest.Mock> = {};
  const deletes: Record<string, jest.Mock> = {};
  const creates: Record<string, jest.Mock> = {};
  const rows: Record<string, any> = {
    "api::payment-attempt.payment-attempt": {
      id: 11,
      Status: "Succeeded",
      providerStatus: "SETTLE",
    },
    "api::order.order": {
      id: 22,
      Status: "Started",
      ShippingBarcode: null,
      order_items: [
        {
          id: 71,
          Count: 2,
          product_variation: {
            product_stock: { id: 91 },
          },
        },
      ],
    },
    "api::contract.contract": {
      id: 33,
      Amount: 220_000,
    },
  };
  const trx = {
    raw: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
  };
  const strapi = {
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    db: {
      transaction: jest.fn(async (callback: any) => callback({ trx })),
      query: jest.fn((uid: string) => {
        updates[uid] ||= jest.fn().mockResolvedValue({});
        deletes[uid] ||= jest.fn().mockResolvedValue({});
        creates[uid] ||= jest.fn().mockResolvedValue({});
        return {
          findOne: jest.fn().mockResolvedValue(rows[uid]),
          findMany: jest.fn().mockResolvedValue(
            uid === "api::contract-transaction.contract-transaction"
              ? [{ id: 44, Step: 1, Type: "Gateway" }]
              : [],
          ),
          update: updates[uid],
          delete: deletes[uid],
          create: creates[uid],
        };
      }),
    },
  } as any;
  return { strapi, trx, updates, deletes, creates };
}

const ids = {
  attemptId: 11,
  orderId: 22,
  contractId: 33,
  transactionRowId: 44,
  transactionId: "ABC1234567",
};

describe("SnappPay admin update finalization", () => {
  it("rejects forged stock deltas before mutating local state", async () => {
    const { strapi, updates, deletes } = createHarness();

    await expect(
      applySnappayAdminUpdate(strapi, ids, {
        changes: [
          {
            orderItemId: 71,
            oldCount: 2,
            newCount: 1,
            restockDelta: 99,
          },
        ],
        newTotalToman: 120_000,
        newDiscountToman: 0,
        newShippingToman: 20_000,
        expectedOldTotalToman: 220_000,
        reason: "One item unavailable",
        actorId: 7,
      }),
    ).rejects.toThrow("SNAPPAY_ADMIN_UPDATE_ITEMS_CHANGED");

    expect(Object.values(updates).some((update) => update.mock.calls.length)).toBe(
      false,
    );
    expect(Object.values(deletes).some((remove) => remove.mock.calls.length)).toBe(
      false,
    );
  });

  it("keeps the order, attempt, and transaction amounts aligned after provider success", async () => {
    const { strapi, updates, creates } = createHarness();

    await applySnappayAdminUpdate(strapi, ids, {
      changes: [
        {
          orderItemId: 71,
          oldCount: 2,
          newCount: 1,
          restockDelta: 1,
        },
      ],
      newTotalToman: 110_000,
      newDiscountToman: 10_000,
      newShippingToman: 20_000,
      expectedOldTotalToman: 220_000,
      reason: "One item unavailable",
      actorId: 7,
    });

    expect(updates["api::order.order"]).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ShippingCost: 20_000,
          AppliedDiscountAmount: 10_000,
        }),
      }),
    );
    expect(updates["api::contract.contract"]).toHaveBeenCalledWith(
      expect.objectContaining({ data: { Amount: 110_000 } }),
    );
    // The original charge is left intact and the reduction is recorded as a
    // Return, matching every other gateway. Editing Amount down instead netted
    // out by accident but left refund_irr at zero and retroactively changed what
    // a past date range reported.
    expect(
      updates["api::contract-transaction.contract-transaction"],
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ GatewayStatus: "SETTLE" }),
      }),
    );
    const txUpdateData =
      updates["api::contract-transaction.contract-transaction"].mock.calls[0][0].data;
    expect(txUpdateData).not.toHaveProperty("Amount");
    expect(txUpdateData).not.toHaveProperty("DiscountAmount");

    expect(
      creates["api::contract-transaction.contract-transaction"],
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          Type: "Return",
          Status: "Success",
          // 220,000 -> 110,000 Toman = 1,100,000 IRR returned.
          Amount: 1_100_000,
          Step: 2,
          contract: 33,
        }),
      }),
    );
    expect(updates["api::payment-attempt.payment-attempt"]).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ Amount: 1_100_000 }),
      }),
    );
  });

  it("logs the returned stock, which the raw UPDATE bypasses", async () => {
    const { strapi, creates } = createHarness();

    await applySnappayAdminUpdate(strapi, ids, {
      changes: [
        { orderItemId: 71, oldCount: 2, newCount: 1, restockDelta: 1 },
      ],
      newTotalToman: 110_000,
      newDiscountToman: 10_000,
      newShippingToman: 20_000,
      expectedOldTotalToman: 220_000,
      reason: "One item unavailable",
      actorId: 7,
    });

    // product-stock-log rows normally come from the product-stock lifecycle hook,
    // which `UPDATE product_stocks SET count = count + ?` never triggers.
    expect(creates["api::product-stock-log.product-stock-log"]).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          product_stock: 91,
          Count: 1,
          Type: "Add",
        }),
      }),
    );
  });

  it("writes no Return transaction when the total does not change", async () => {
    const { strapi, creates } = createHarness();

    await applySnappayAdminUpdate(strapi, ids, {
      changes: [
        { orderItemId: 71, oldCount: 2, newCount: 2, restockDelta: 0 },
      ],
      newTotalToman: 220_000,
      newDiscountToman: 0,
      newShippingToman: 20_000,
      expectedOldTotalToman: 220_000,
      reason: "Metadata correction",
      actorId: 7,
    });

    const returnCreates = (
      creates["api::contract-transaction.contract-transaction"]?.mock.calls || []
    ).filter(([arg]: any) => arg?.data?.Type === "Return");
    expect(returnCreates).toHaveLength(0);
  });
});
