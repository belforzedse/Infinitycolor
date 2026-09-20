import { finalizeSnappaySettlement } from "../services/snappay-finalization";
import { consumeOrderReservation } from "../../../utils/stockReservations";
import { decrementStockAtomic } from "../../cart/services/lib/stock";
import { captureWalletLegForSettlement } from "../../local-user-wallet/services/wallet-holds";

jest.mock("../../../utils/stockReservations", () => ({
  consumeOrderReservation: jest.fn(),
  releaseOrderReservation: jest.fn().mockResolvedValue({ outcome: "released" }),
}));

jest.mock("../../cart/services/lib/stock", () => ({
  decrementStockAtomic: jest.fn().mockResolvedValue({ success: true, newCount: 8 }),
}));

jest.mock("../../local-user-wallet/services/wallet-holds", () => ({
  captureWalletLegForSettlement: jest.fn().mockResolvedValue({ outcome: "none" }),
}));

jest.mock("../../cart/services/lib/discount-claim", () => ({
  hasDiscountClaim: jest.fn().mockResolvedValue(false),
  releaseOrderDiscountClaim: jest.fn().mockResolvedValue({ released: false }),
}));

jest.mock("../../reserve-group/lib/reserve-group", () => ({
  confirmReservePaymentForOrder: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@sentry/node", () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

const consumeMock = consumeOrderReservation as jest.MockedFunction<typeof consumeOrderReservation>;
const decrementMock = decrementStockAtomic as jest.MockedFunction<typeof decrementStockAtomic>;
const captureWalletMock = captureWalletLegForSettlement as jest.MockedFunction<
  typeof captureWalletLegForSettlement
>;

const ids = {
  attemptId: 11,
  orderId: 22,
  contractId: 33,
  transactionRowId: 44,
  transactionId: "ABC1234567",
};

function createHarness(reservationStatus: string) {
  const updates: Record<string, jest.Mock> = {};
  const creates: Record<string, jest.Mock> = {};
  const rows: Record<string, any> = {
    "api::payment-attempt.payment-attempt": { id: 11, Status: "Pending", providerStatus: "SETTLE" },
    "api::order.order": {
      id: 22,
      Status: "Paying",
      ReservationStatus: reservationStatus,
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
      query: jest.fn((uid: string) => {
        updates[uid] ||= jest.fn().mockResolvedValue({});
        creates[uid] ||= jest.fn().mockResolvedValue({});
        return {
          findOne: jest.fn().mockResolvedValue(rows[uid]),
          findMany: jest.fn().mockResolvedValue([]),
          update: updates[uid],
          delete: jest.fn(),
          create: creates[uid],
        };
      }),
    },
  } as any;
  return { strapi, rows, updates, creates };
}

/** The order-status update, as opposed to the ReservationStatus bookkeeping one. */
const orderStatusUpdate = (updates: Record<string, jest.Mock>) =>
  updates["api::order.order"]?.mock.calls
    .map((call) => call[0]?.data)
    .find((data) => data?.Status);

describe("SnappPay settlement when the reservation clock has lapsed", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    decrementMock.mockResolvedValue({ success: true, newCount: 8 });
    captureWalletMock.mockResolvedValue({ outcome: "none" } as any);
  });

  it("completes a captured gateway-only order whose reservation already expired", async () => {
    const { strapi, updates } = createHarness("Expired");

    await expect(finalizeSnappaySettlement(strapi, ids)).resolves.toEqual({ replayed: false });

    // Stock taken directly — there is no reservation left to consume.
    expect(decrementMock).toHaveBeenCalledTimes(1);
    expect(decrementMock).toHaveBeenCalledWith(strapi, 91, 2, expect.anything());
    expect(orderStatusUpdate(updates)).toEqual(expect.objectContaining({ Status: "Started" }));
  });

  it("recovers when the clock lapses between the provider leg and the consume", async () => {
    consumeMock.mockResolvedValue({ outcome: "skipped", reason: "expired", expired: true } as any);
    const { strapi, updates } = createHarness("Reserved");

    await expect(finalizeSnappaySettlement(strapi, ids)).resolves.toEqual({ replayed: false });

    expect(decrementMock).toHaveBeenCalledWith(strapi, 91, 2, expect.anything());
    expect(orderStatusUpdate(updates)).toEqual(expect.objectContaining({ Status: "Started" }));
  });

  it("still consumes the reservation normally when it has not lapsed", async () => {
    consumeMock.mockResolvedValue({ outcome: "consumed" } as any);
    const { strapi, updates } = createHarness("Reserved");

    await expect(finalizeSnappaySettlement(strapi, ids)).resolves.toEqual({ replayed: false });

    expect(decrementMock).not.toHaveBeenCalled();
    expect(orderStatusUpdate(updates)).toEqual(expect.objectContaining({ Status: "Started" }));
  });

  it("marks the reservation Consumed so a replay does not take the stock twice", async () => {
    const { strapi, updates } = createHarness("Expired");

    await finalizeSnappaySettlement(strapi, ids);

    const reservationUpdate = updates["api::order.order"].mock.calls
      .map((call) => call[0]?.data)
      .find((data) => data?.ReservationStatus);
    expect(reservationUpdate).toEqual({ ReservationStatus: "Consumed" });
  });

  it("refuses to mark the order paid when the stock is genuinely gone", async () => {
    decrementMock.mockResolvedValue({ success: false, error: "Insufficient stock" });
    const { strapi, updates } = createHarness("Expired");

    await expect(finalizeSnappaySettlement(strapi, ids)).rejects.toThrow(
      "SNAPPAY_SETTLED_STOCK_UNAVAILABLE:91",
    );
    expect(orderStatusUpdate(updates)).toBeUndefined();
  });

  it("refuses when the wallet leg was released with the reservation (mixed tender)", async () => {
    captureWalletMock.mockResolvedValue({ outcome: "not_active", status: "Released" } as any);
    const { strapi, updates } = createHarness("Expired");

    await expect(finalizeSnappaySettlement(strapi, ids)).rejects.toThrow(
      "SNAPPAY_WALLET_HOLD_NOT_ACTIVE:Released",
    );
    expect(orderStatusUpdate(updates)).toBeUndefined();
  });

  it("does not silently recover — the lapse is reported", async () => {
    const { strapi } = createHarness("Expired");

    await finalizeSnappaySettlement(strapi, ids);

    expect(strapi.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("reservation lapsed"),
    );
  });
});
