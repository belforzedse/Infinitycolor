import {
  settleZarinPalPayment,
  ZarinPalSettlementError,
} from "../controllers/helpers/zarinpalSettlement";
import { consumeOrderReservation } from "../../../utils/stockReservations";
import { decrementStockAtomic } from "../../cart/services/lib/stock";
import {
  findOrderPaymentAttempt,
  updatePaymentAttempt,
} from "../../payment-attempt/services/payment-attempt-store";

jest.mock("../../../utils/stockReservations", () => ({
  consumeOrderReservation: jest.fn(),
}));
jest.mock("../../cart/services/lib/stock", () => ({
  decrementStockAtomic: jest.fn(),
}));
jest.mock("../../payment-attempt/services/payment-attempt-store", () => ({
  findOrderPaymentAttempt: jest.fn(),
  updatePaymentAttempt: jest.fn(),
}));

const mockedConsume = consumeOrderReservation as jest.MockedFunction<
  typeof consumeOrderReservation
>;
const mockedDecrement = decrementStockAtomic as jest.MockedFunction<
  typeof decrementStockAtomic
>;
const mockedFindAttempt = findOrderPaymentAttempt as jest.MockedFunction<
  typeof findOrderPaymentAttempt
>;
const mockedUpdateAttempt = updatePaymentAttempt as jest.MockedFunction<
  typeof updatePaymentAttempt
>;

function createHarness(options: {
  orderStatus?: string;
  reservationStatus?: string;
  transactionStatus?: string;
} = {}) {
  const trx = { raw: jest.fn().mockResolvedValue({ rows: [{ id: 30 }] }) };
  const transactionFindOne = jest.fn().mockResolvedValue({
    id: 30,
    Status: options.transactionStatus || "Pending",
  });
  const transactionUpdate = jest.fn().mockResolvedValue({ id: 30 });
  const orderFindOne = jest.fn().mockResolvedValue({
    id: 10,
    Status: options.orderStatus || "Paying",
    ReservationStatus: options.reservationStatus || "Reserved",
    order_items: [
      {
        Count: 2,
        product_variation: { product_stock: { id: 90 } },
      },
    ],
  });
  const orderUpdate = jest.fn().mockResolvedValue({ id: 10 });
  const contractUpdate = jest.fn().mockResolvedValue({ id: 20 });
  const queries: Record<string, any> = {
    "api::contract-transaction.contract-transaction": {
      findOne: transactionFindOne,
      update: transactionUpdate,
    },
    "api::order.order": { findOne: orderFindOne, update: orderUpdate },
    "api::contract.contract": { update: contractUpdate },
  };
  const strapi = {
    db: {
      query: jest.fn((uid: string) => queries[uid]),
      transaction: jest.fn(async (callback: any) => callback({ trx })),
    },
  } as any;
  return {
    strapi,
    trx,
    transactionFindOne,
    transactionUpdate,
    orderFindOne,
    orderUpdate,
    contractUpdate,
  };
}

const settlementParams = {
  orderId: 10,
  contractId: 20,
  contractTransactionId: 30,
  authority: "AUTH-10",
  verification: {
    refId: "REF-10",
    alreadyVerified: false,
    gatewayResponse: { data: { code: 100 } },
  },
};

describe("settleZarinPalPayment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedConsume.mockResolvedValue({ outcome: "consumed" } as any);
    mockedDecrement.mockResolvedValue({ success: true, newCount: 8 });
    mockedFindAttempt.mockResolvedValue(null as any);
    mockedUpdateAttempt.mockResolvedValue({} as any);
  });

  it("consumes a reservation and commits payment, contract, and order state in one transaction", async () => {
    const harness = createHarness();
    mockedFindAttempt.mockResolvedValueOnce({ id: 40 } as any);

    const result = await settleZarinPalPayment(harness.strapi, settlementParams);

    expect(harness.trx.raw).toHaveBeenCalledWith(
      "SELECT id FROM contract_transactions WHERE id = ? FOR UPDATE",
      [30],
    );
    expect(mockedConsume).toHaveBeenCalledWith(harness.strapi, 10, harness.trx);
    expect(harness.contractUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ transacting: harness.trx }),
    );
    expect(harness.orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ Status: "Started", external_id: "REF-10" }),
        transacting: harness.trx,
      }),
    );
    expect(harness.transactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          Status: "Success",
          GatewayAuthority: "AUTH-10",
          GatewayRefId: "REF-10",
        }),
        transacting: harness.trx,
      }),
    );
    expect(mockedUpdateAttempt).toHaveBeenCalledWith(
      harness.strapi,
      40,
      expect.objectContaining({ Status: "Succeeded", providerReference: "REF-10" }),
      harness.trx,
    );
    expect(result).toEqual({
      success: true,
      replayed: false,
      finalReference: "REF-10",
    });
  });

  it("does not consume stock again when the reservation is already consumed", async () => {
    const harness = createHarness({ reservationStatus: "Consumed" });

    await settleZarinPalPayment(harness.strapi, settlementParams);

    expect(mockedConsume).not.toHaveBeenCalled();
    expect(mockedDecrement).not.toHaveBeenCalled();
    expect(harness.transactionUpdate).toHaveBeenCalled();
  });

  it("rejects a late verified callback after cancellation or reservation release", async () => {
    const harness = createHarness({
      orderStatus: "Cancelled",
      reservationStatus: "Released",
    });

    await expect(
      settleZarinPalPayment(harness.strapi, settlementParams),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ZarinPalSettlementError>>({
        code: "ZARINPAL_LOCAL_STATE_CONFLICT",
      }),
    );
    expect(mockedConsume).not.toHaveBeenCalled();
    expect(mockedDecrement).not.toHaveBeenCalled();
    expect(harness.orderUpdate).not.toHaveBeenCalled();
    expect(harness.transactionUpdate).not.toHaveBeenCalled();
  });

  it("keeps legacy non-reserved orders atomic by passing the transaction to stock decrement", async () => {
    const harness = createHarness({ reservationStatus: "None" });

    await settleZarinPalPayment(harness.strapi, settlementParams);

    expect(mockedDecrement).toHaveBeenCalledWith(
      harness.strapi,
      90,
      2,
      harness.trx,
    );
  });

  it("returns an idempotent replay without touching stock or local state", async () => {
    const harness = createHarness({ transactionStatus: "Success" });
    harness.transactionFindOne.mockResolvedValueOnce({
      id: 30,
      Status: "Success",
      GatewayRefId: "REF-PERSISTED",
    });

    const result = await settleZarinPalPayment(harness.strapi, settlementParams);

    expect(result).toEqual({
      success: true,
      replayed: true,
      finalReference: "REF-PERSISTED",
    });
    expect(harness.orderFindOne).not.toHaveBeenCalled();
    expect(mockedConsume).not.toHaveBeenCalled();
    expect(mockedDecrement).not.toHaveBeenCalled();
    expect(harness.transactionUpdate).not.toHaveBeenCalled();
  });
});
