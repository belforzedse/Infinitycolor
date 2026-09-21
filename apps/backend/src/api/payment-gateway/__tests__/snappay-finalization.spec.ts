import {
  applySnappayCancellation,
  applySnappayAdminUpdate,
  finalizeSnappaySettlement,
} from "../services/snappay-finalization";
import { notifyAnipoParcelCancelled } from "../../order/controllers/helpers/notifyAnipoParcelCancelled";

jest.mock("../../order/controllers/helpers/notifyAnipoParcelCancelled", () => {
  const actual = jest.requireActual("../../order/controllers/helpers/notifyAnipoParcelCancelled");
  return {
    ...actual,
    notifyAnipoParcelCancelled: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock("../../cart/services/lib/discount-claim", () => ({
  hasDiscountClaim: jest.fn().mockResolvedValue(false),
  releaseOrderDiscountClaim: jest.fn().mockResolvedValue({ released: false }),
}));

const notifyAnipoMock = notifyAnipoParcelCancelled as jest.MockedFunction<
  typeof notifyAnipoParcelCancelled
>;

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
      ReservationStatus: "Consumed",
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
    "api::contract-transaction.contract-transaction": {
      id: 44,
      GatewayStatus: "SETTLE",
      TrackId: "provider-payment-token",
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
          findMany: jest
            .fn()
            .mockResolvedValue(
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
  return { strapi, trx, rows, updates, deletes, creates };
}

const ids = {
  attemptId: 11,
  orderId: 22,
  contractId: 33,
  transactionRowId: 44,
  transactionId: "ABC1234567",
};

describe("SnappPay admin update finalization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    notifyAnipoMock.mockResolvedValue(undefined);
  });

  it("retains the provider token after settlement for later cancel/update calls", async () => {
    const { strapi, rows, updates } = createHarness();
    rows["api::payment-attempt.payment-attempt"].Status = "Pending";

    await finalizeSnappaySettlement(strapi, ids);

    const transactionUpdate =
      updates["api::contract-transaction.contract-transaction"].mock.calls[0][0].data;
    expect(transactionUpdate).toEqual(
      expect.objectContaining({
        Status: "Success",
        GatewayStatus: "SETTLE",
      }),
    );
    expect(transactionUpdate).not.toHaveProperty("TrackId");
  });

  it.each(["CANCEL", "REVERT"] as const)(
    "retains the provider token after a confirmed %s",
    async (providerStatus) => {
      const { strapi, rows, updates } = createHarness();
      rows["api::order.order"].ReservationStatus = "Released";

      await applySnappayCancellation(strapi, ids, providerStatus, "Operator cancellation");

      const transactionUpdate =
        updates["api::contract-transaction.contract-transaction"].mock.calls[0][0].data;
      expect(transactionUpdate).toEqual(
        expect.objectContaining({
          // The settled funding row remains historical truth; cancellation is
          // represented by Return rows so split legs reconcile exactly.
          Status: "Success",
          GatewayStatus: providerStatus,
        }),
      );
      expect(transactionUpdate).not.toHaveProperty("TrackId");
    },
  );

  it.each(["Done", "Shipment"] as const)(
    "cancels a %s order, restocks consumed inventory, and clears the local barcode",
    async (status) => {
      const { strapi, rows, updates, trx } = createHarness();
      rows["api::order.order"].Status = status;
      rows["api::order.order"].ShippingBarcode = "ANIPO-SHIPPED";
      rows["api::order.order"].AnipoBarcodeState = "Issued";
      rows["api::order.order"].ReservationStatus = "Consumed";

      await applySnappayCancellation(
        strapi,
        ids,
        "CANCEL",
        "Operator cancellation after fulfilment",
      );

      expect(trx.raw).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE product_stocks"),
        [2, 91],
      );
      const orderUpdates = updates["api::order.order"].mock.calls.map((call) => call[0].data);
      expect(orderUpdates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ReservationStatus: "Released",
            ReservedUntil: null,
          }),
          expect.objectContaining({
            Status: "Cancelled",
            ShippingBarcode: null,
            AnipoBarcodeState: "Voided",
          }),
        ]),
      );
      expect(notifyAnipoMock).toHaveBeenCalledWith(
        strapi,
        22,
        expect.objectContaining({
          shippingBarcode: "ANIPO-SHIPPED",
          anipoBarcodeState: "Issued",
        }),
      );
    },
  );

  it("notifies Anipo after a confirmed cancel commits", async () => {
    const { strapi, rows } = createHarness();
    rows["api::order.order"].ReservationStatus = "Released";
    rows["api::order.order"].ShippingBarcode = "ANIPO-1";
    rows["api::order.order"].AnipoBarcodeState = "Issued";

    await expect(
      applySnappayCancellation(strapi, ids, "CANCEL", "Operator cancellation"),
    ).resolves.toEqual({ replayed: false });

    expect(notifyAnipoMock).toHaveBeenCalledWith(
      strapi,
      22,
      expect.objectContaining({ shippingBarcode: "ANIPO-1" }),
    );
  });

  it("does not notify Anipo on cancel replay", async () => {
    const { strapi, rows } = createHarness();
    rows["api::payment-attempt.payment-attempt"].Status = "Cancelled";
    rows["api::payment-attempt.payment-attempt"].providerStatus = "CANCEL";

    await expect(applySnappayCancellation(strapi, ids, "CANCEL", "replay")).resolves.toEqual({
      replayed: true,
    });

    expect(notifyAnipoMock).not.toHaveBeenCalled();
  });

  it.each(["Expired", "Cancelled", "Failed", "Succeeded"] as const)(
    "treats a locally decided cancel as a replay when the attempt is already %s",
    async (status) => {
      const { strapi, rows, updates } = createHarness();
      // The reservation sweep stamps `Expired`, not `Cancelled`, so the narrow
      // replay check below would miss it: a confirmed NOT_FOUND landing at
      // +30:59 against a sweep that won at +31:00 would re-run the release and
      // write a second `released` evidence row for the same money, which the
      // 24-hour wallet value breaker would then count twice.
      rows["api::payment-attempt.payment-attempt"].Status = status;
      rows["api::payment-attempt.payment-attempt"].providerStatus = "PENDING";

      await expect(
        applySnappayCancellation(strapi, ids, "NOT_FOUND", "provider_not_found_confirmed", {
          walletReleaseReason: "provider_not_found_confirmed",
        }),
      ).resolves.toEqual({ replayed: true });

      // Nothing was written anywhere: the guard returns before the order is
      // even read, and the attempt's update spy (created when the guard read
      // the row) was never called.
      expect(updates["api::order.order"]).toBeUndefined();
      expect(updates["api::payment-attempt.payment-attempt"]).not.toHaveBeenCalled();
    },
  );

  it("still lets an operator cancel a settled order on the provider side", async () => {
    const { strapi, rows, updates } = createHarness();
    rows["api::payment-attempt.payment-attempt"].Status = "Succeeded";
    rows["api::payment-attempt.payment-attempt"].providerStatus = "SETTLE";
    rows["api::order.order"].ReservationStatus = "Released";

    await expect(
      applySnappayCancellation(strapi, ids, "CANCEL", "Operator cancellation"),
    ).resolves.toEqual({ replayed: false });

    expect(updates["api::payment-attempt.payment-attempt"]).toHaveBeenCalled();
  });

  it("still refuses cancellation after the order is Returned", async () => {
    const { strapi, rows, updates } = createHarness();
    rows["api::order.order"].Status = "Returned";

    await expect(applySnappayCancellation(strapi, ids, "CANCEL", "Too late")).rejects.toThrow(
      "SNAPPAY_FULFILLMENT_ALREADY_STARTED",
    );

    expect(updates["api::order.order"]).not.toHaveBeenCalled();
  });

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

    expect(Object.values(updates).some((update) => update.mock.calls.length)).toBe(false);
    expect(Object.values(deletes).some((remove) => remove.mock.calls.length)).toBe(false);
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
    expect(updates["api::contract-transaction.contract-transaction"]).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ GatewayStatus: "SETTLE" }),
      }),
    );
    const txUpdateData =
      updates["api::contract-transaction.contract-transaction"].mock.calls[0][0].data;
    expect(txUpdateData).not.toHaveProperty("Amount");
    expect(txUpdateData).not.toHaveProperty("DiscountAmount");

    expect(creates["api::contract-transaction.contract-transaction"]).toHaveBeenCalledWith(
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
      changes: [{ orderItemId: 71, oldCount: 2, newCount: 1, restockDelta: 1 }],
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
      changes: [{ orderItemId: 71, oldCount: 2, newCount: 2, restockDelta: 0 }],
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
