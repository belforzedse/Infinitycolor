import { settleOrderWithWallet } from "../controllers/handlers/wallet-settlement";
import { deductWalletBalanceAtomic } from "../../local-user-wallet/services/local-user-wallet";
import { consumeOrderReservation } from "../../../utils/stockReservations";

jest.mock("../../local-user-wallet/services/local-user-wallet", () => ({
  deductWalletBalanceAtomic: jest.fn(),
}));
jest.mock("../../../utils/stockReservations", () => ({
  consumeOrderReservation: jest.fn(),
}));

const mockedDebit = deductWalletBalanceAtomic as jest.MockedFunction<
  typeof deductWalletBalanceAtomic
>;
const mockedConsume = consumeOrderReservation as jest.MockedFunction<
  typeof consumeOrderReservation
>;

function createStrapi(attemptStatus = "Created") {
  const trx = { marker: "test-transaction", raw: jest.fn().mockResolvedValue({ rows: [{ id: 70 }] }) };
  const queries: Record<string, any> = {
    "api::payment-attempt.payment-attempt": {
      findOne: jest.fn().mockResolvedValue({
        id: 70,
        Status: attemptStatus,
        providerReference: attemptStatus === "Succeeded" ? "existing-reference" : null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    "api::local-user-wallet-transaction.local-user-wallet-transaction": {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 81 }),
    },
    "api::payment-gateway.payment-gateway": {
      findOne: jest.fn().mockResolvedValue({ id: 5, Title: "Wallet" }),
      create: jest.fn(),
    },
    "api::contract-transaction.contract-transaction": {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 82 }),
    },
    "api::contract.contract": { update: jest.fn().mockResolvedValue({}) },
    "api::order.order": { update: jest.fn().mockResolvedValue({}) },
    "api::order-log.order-log": { create: jest.fn().mockResolvedValue({}) },
  };
  const strapi = {
    db: {
      query: jest.fn((uid: string) => queries[uid]),
      transaction: jest.fn(async (callback: any) => callback({ trx })),
    },
  } as any;
  return { strapi, queries, trx };
}

describe("settleOrderWithWallet", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedDebit.mockResolvedValue({ success: true, walletId: 11, newBalance: 9_000_000 });
    mockedConsume.mockResolvedValue({ outcome: "consumed" } as any);
  });

  it("commits the debit, ledgers, stock consumption, order, contract and attempt together", async () => {
    const { strapi, queries, trx } = createStrapi();

    const result = await settleOrderWithWallet(strapi, {
      userId: 3,
      orderId: 40,
      contractId: 50,
      paymentAttemptId: 70,
      attemptId: "attempt-40",
      totalToman: 120_000,
      discountToman: 10_000,
    });

    expect(mockedDebit).toHaveBeenCalledWith(strapi, 3, 1_200_000, trx);
    expect(trx.raw).toHaveBeenCalledWith(
      "SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE",
      [70],
    );
    expect(mockedConsume).toHaveBeenCalledWith(strapi, 40, trx);
    expect(queries["api::local-user-wallet-transaction.local-user-wallet-transaction"].create)
      .toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          Amount: 1_200_000,
          Type: "Minus",
          ReferenceId: "wallet-order-40-attempt-40",
        }),
        transacting: trx,
      }));
    expect(queries["api::contract-transaction.contract-transaction"].create)
      .toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          Amount: 1_200_000,
          DiscountAmount: 100_000,
          Status: "Success",
        }),
      }));
    expect(queries["api::order.order"].update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ Status: "Started" }) }),
    );
    expect(queries["api::payment-attempt.payment-attempt"].update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ Status: "Succeeded" }) }),
    );
    expect(result).toEqual(expect.objectContaining({
      success: true,
      reference: "wallet-order-40-attempt-40",
    }));
  });

  it("is idempotent after the same attempt has already succeeded", async () => {
    const { strapi, queries } = createStrapi("Succeeded");

    const result = await settleOrderWithWallet(strapi, {
      userId: 3,
      orderId: 40,
      contractId: 50,
      paymentAttemptId: 70,
      attemptId: "attempt-40",
      totalToman: 120_000,
      discountToman: 0,
    });

    expect(result).toEqual({ success: true, reference: "existing-reference" });
    expect(mockedDebit).not.toHaveBeenCalled();
    expect(queries["api::order.order"].update).not.toHaveBeenCalled();
  });

  it("rejects a terminal non-success attempt before touching wallet or stock", async () => {
    const { strapi } = createStrapi("Failed");

    await expect(settleOrderWithWallet(strapi, {
      userId: 3,
      orderId: 40,
      contractId: 50,
      paymentAttemptId: 70,
      attemptId: "attempt-40",
      totalToman: 120_000,
      discountToman: 0,
    })).rejects.toThrow("PAYMENT_ATTEMPT_NOT_SETTLEABLE:Failed");

    expect(mockedDebit).not.toHaveBeenCalled();
    expect(mockedConsume).not.toHaveBeenCalled();
  });

  it("does not write any financial or order state when the debit fails", async () => {
    const { strapi, queries } = createStrapi();
    mockedDebit.mockResolvedValueOnce({ success: false, error: "Insufficient balance" });

    await expect(settleOrderWithWallet(strapi, {
      userId: 3,
      orderId: 40,
      contractId: 50,
      paymentAttemptId: 70,
      attemptId: "attempt-40",
      totalToman: 120_000,
      discountToman: 0,
    })).rejects.toThrow("WALLET_DEBIT_FAILED:Insufficient balance");

    expect(mockedConsume).not.toHaveBeenCalled();
    expect(queries["api::local-user-wallet-transaction.local-user-wallet-transaction"].create)
      .not.toHaveBeenCalled();
    expect(queries["api::order.order"].update).not.toHaveBeenCalled();
    expect(queries["api::payment-attempt.payment-attempt"].update).not.toHaveBeenCalled();
  });
});
