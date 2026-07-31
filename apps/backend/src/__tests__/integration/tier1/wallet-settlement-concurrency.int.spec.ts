/**
 * Real-Postgres proof that one checkout attempt cannot debit the wallet twice
 * when duplicate finalize requests overlap.
 */
import { settleOrderWithWallet } from "../../../api/cart/controllers/handlers/wallet-settlement";
import { claimPaymentAttemptForInitiation } from "../../../api/payment-attempt/services/claim-payment-attempt";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

let strapi: any;
let f: Factories;

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterAll(async () => {
  await teardownStrapi();
});

beforeEach(() => {
  f = makeFactories(strapi);
});

afterEach(async () => {
  await f.cleanup();
});

describe("wallet settlement concurrency", () => {
  it("allows only one overlapping request to claim an external provider attempt", async () => {
    const user = await f.createUser();
    const contract = await f.createContract({
      amount: 100_000,
      status: "Not Ready",
      type: "Cash",
      userId: user.id,
    });
    const reserved = await f.createReservedOrder({
      userId: user.id,
      contractId: contract.id,
      items: [{ count: 1, stockCount: 2, stockReserved: 1, perAmount: 100_000 }],
    });
    const attempt = await f.createPaymentAttempt({
      userId: user.id,
      orderId: reserved.order.id,
      contractId: contract.id,
      amountIrr: 1_000_000,
      attemptId: `provider-concurrent-${reserved.order.id}`,
    });

    const claims = await Promise.all([
      claimPaymentAttemptForInitiation(strapi, attempt.id),
      claimPaymentAttemptForInitiation(strapi, attempt.id),
    ]);

    expect(claims.sort()).toEqual([false, true]);
    const persisted = await strapi.db
      .query("api::payment-attempt.payment-attempt")
      .findOne({ where: { id: attempt.id } });
    expect(persisted.Status).toBe("Pending");
  });

  it("serializes duplicate settlement and commits one debit, ledger, and stock consume", async () => {
    const totalToman = 250_000;
    const totalIrr = totalToman * 10;
    const user = await f.createUser();
    const wallet = await f.createWallet({ userId: user.id, balanceIrr: totalIrr * 3 });
    const contract = await f.createContract({
      amount: totalToman,
      status: "Not Ready",
      type: "Cash",
      userId: user.id,
    });
    const reserved = await f.createReservedOrder({
      userId: user.id,
      contractId: contract.id,
      items: [{ count: 2, stockCount: 10, stockReserved: 2, perAmount: 125_000 }],
    });
    const attempt = await f.createPaymentAttempt({
      userId: user.id,
      orderId: reserved.order.id,
      contractId: contract.id,
      amountIrr: totalIrr,
      attemptId: `wallet-concurrent-${reserved.order.id}`,
    });
    const params = {
      userId: user.id,
      orderId: reserved.order.id,
      contractId: contract.id,
      paymentAttemptId: attempt.id,
      attemptId: attempt.attemptId,
      totalToman,
      discountToman: 0,
    };

    const [first, second] = await Promise.all([
      settleOrderWithWallet(strapi, params),
      settleOrderWithWallet(strapi, params),
    ]);

    expect(first).toEqual(expect.objectContaining({ success: true }));
    expect(second).toEqual(expect.objectContaining({
      success: true,
      reference: first.reference,
    }));

    const persistedWallet = await strapi.db
      .query("api::local-user-wallet.local-user-wallet")
      .findOne({ where: { id: wallet.id } });
    const walletLedgers = await strapi.db
      .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
      .findMany({ where: { ReferenceId: first.reference } });
    const contractLedgers = await f.getContractTransactions(contract.id);
    const persistedAttempt = await strapi.db
      .query("api::payment-attempt.payment-attempt")
      .findOne({ where: { id: attempt.id } });
    const persistedOrder = await f.getOrder(reserved.order.id);
    const stock = await f.getStock(reserved.items[0].stockId);

    expect(Number(persistedWallet.Balance)).toBe(totalIrr * 2);
    expect(walletLedgers).toHaveLength(1);
    expect(contractLedgers.filter((tx: any) => tx.external_source === "Wallet")).toHaveLength(1);
    expect(persistedAttempt.Status).toBe("Succeeded");
    expect(persistedOrder.Status).toBe("Started");
    expect(persistedOrder.ReservationStatus).toBe("Consumed");
    expect(Number(stock.Count)).toBe(8);
    expect(Number(stock.reservedCount)).toBe(0);
  });
});
