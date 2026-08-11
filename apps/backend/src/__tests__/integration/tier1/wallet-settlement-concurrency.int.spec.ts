/**
 * Real-Postgres proof that one checkout attempt cannot debit the wallet twice
 * when duplicate finalize requests overlap.
 */
import { settleOrderWithWallet } from "../../../api/cart/controllers/handlers/wallet-settlement";
import { claimPaymentAttemptForInitiation } from "../../../api/payment-attempt/services/claim-payment-attempt";
import { applyAdminWalletAdjustment } from "../../../api/local-user-wallet/services/local-user-wallet";
import { applyConfirmedWalletTopup } from "../../../api/wallet-topup/services/wallet-topup";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

let strapi: any;
let f: Factories;

const integrationAudit = {
  initiator: { type: "system" as const, id: "wallet-concurrency-test", label: "Wallet concurrency test" },
  actor: { type: "system" as const, id: "jest", label: "Jest" },
  origin: "maintenance" as const,
};

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

  it("serializes admin set against credit without a lost update", async () => {
    const user = await f.createUser();
    const wallet = await f.createWallet({ userId: user.id, balanceIrr: 1_000 });

    const results = await Promise.all([
      applyAdminWalletAdjustment(strapi, {
        userId: user.id,
        mode: "set",
        amountIrr: 2_000,
        reason: "integration set",
        audit: integrationAudit,
      }),
      applyAdminWalletAdjustment(strapi, {
        userId: user.id,
        mode: "credit",
        amountIrr: 300,
        reason: "integration credit",
        audit: integrationAudit,
      }),
    ]);

    const first = results.find((result) => result.beforeBalance === 1_000);
    const second = results.find((result) => result !== first);
    expect(first).toBeDefined();
    expect(second?.beforeBalance).toBe(first?.afterBalance);
    const persisted = await strapi.db
      .query("api::local-user-wallet.local-user-wallet")
      .findOne({ where: { id: wallet.id } });
    expect(Number(persisted.Balance)).toBe(second?.afterBalance);
    expect([2_000, 2_300]).toContain(Number(persisted.Balance));
    const ledgers = await strapi.db
      .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
      .findMany({ where: { user_wallet: { id: wallet.id } } });
    expect(ledgers).toHaveLength(2);
  });

  it("credits a confirmed top-up exactly once under concurrent replay", async () => {
    const user = await f.createUser();
    const wallet = await f.createWallet({ userId: user.id, balanceIrr: 1_000 });
    const reference = `JEST_TEST__topup-race-${Date.now()}`;
    const topup = await strapi.db.query("api::wallet-topup.wallet-topup").create({
      data: {
        Amount: 500,
        Status: "Processing",
        SaleOrderId: `JEST_TEST__sale-${Date.now()}`,
        SaleReferenceId: reference,
        NextReconcileAt: new Date(Date.now() + 60_000),
        ReconcileAttempts: 1,
        user: user.id,
        Date: new Date(),
      },
    });

    const results = await Promise.all([
      applyConfirmedWalletTopup(strapi, {
        topupId: topup.id,
        saleReferenceId: reference,
        providerCode: 45,
      }),
      applyConfirmedWalletTopup(strapi, {
        topupId: topup.id,
        saleReferenceId: reference,
        providerCode: 45,
      }),
    ]);

    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    const persistedWallet = await strapi.db
      .query("api::local-user-wallet.local-user-wallet")
      .findOne({ where: { id: wallet.id } });
    expect(Number(persistedWallet.Balance)).toBe(1_500);
    const ledgers = await strapi.db
      .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
      .findMany({ where: { ReferenceId: reference } });
    expect(ledgers).toHaveLength(1);
    const persistedTopup = await strapi.db.query("api::wallet-topup.wallet-topup").findOne({
      where: { id: topup.id },
    });
    expect(persistedTopup.Status).toBe("Success");
    expect(persistedTopup.NextReconcileAt).toBeFalsy();

    await strapi.db.query("api::wallet-topup.wallet-topup").delete({ where: { id: topup.id } });
  });

  it("serializes a confirmed top-up against an admin debit", async () => {
    const user = await f.createUser();
    const wallet = await f.createWallet({ userId: user.id, balanceIrr: 1_000 });
    const reference = `JEST_TEST__topup-debit-${Date.now()}`;
    const topup = await strapi.db.query("api::wallet-topup.wallet-topup").create({
      data: {
        Amount: 500,
        Status: "Processing",
        SaleOrderId: `JEST_TEST__sale-debit-${Date.now()}`,
        SaleReferenceId: reference,
        NextReconcileAt: new Date(Date.now() + 60_000),
        ReconcileAttempts: 1,
        user: user.id,
        Date: new Date(),
      },
    });

    await Promise.all([
      applyConfirmedWalletTopup(strapi, {
        topupId: topup.id,
        saleReferenceId: reference,
        providerCode: 0,
      }),
      applyAdminWalletAdjustment(strapi, {
        userId: user.id,
        mode: "debit",
        amountIrr: 200,
        reason: "integration concurrent debit",
        audit: integrationAudit,
      }),
    ]);

    expect(
      Number(
        (
          await strapi.db.query("api::local-user-wallet.local-user-wallet").findOne({
            where: { id: wallet.id },
          })
        ).Balance,
      ),
    ).toBe(1_300);
    const ledgers = await strapi.db
      .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
      .findMany({ where: { user_wallet: { id: wallet.id } } });
    expect(ledgers).toHaveLength(2);
    expect(ledgers.map((ledger: any) => ledger.Type).sort()).toEqual(["Add", "Minus"]);

    await strapi.db.query("api::wallet-topup.wallet-topup").delete({ where: { id: topup.id } });
  });

  it("treats a zero-delta admin set as an idempotent no-op", async () => {
    const user = await f.createUser();
    const wallet = await f.createWallet({ userId: user.id, balanceIrr: 1_000 });

    await expect(
      applyAdminWalletAdjustment(strapi, {
        userId: user.id,
        mode: "set",
        amountIrr: 1_000,
        reason: "integration no-op",
        audit: integrationAudit,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        walletId: wallet.id,
        beforeBalance: 1_000,
        afterBalance: 1_000,
        delta: 0,
        changed: false,
        ledgerId: null,
      }),
    );
    expect(
      await strapi.db
        .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
        .findMany({ where: { user_wallet: { id: wallet.id } } }),
    ).toHaveLength(0);
  });

  it("rolls wallet credit back when the top-up ledger insert fails, then retries safely", async () => {
    const user = await f.createUser();
    const wallet = await f.createWallet({ userId: user.id, balanceIrr: 2_000 });
    const reference = `JEST_TEST__topup-local-failure-${Date.now()}`;
    const topup = await strapi.db.query("api::wallet-topup.wallet-topup").create({
      data: {
        Amount: 700,
        Status: "Processing",
        SaleOrderId: `JEST_TEST__sale-failure-${Date.now()}`,
        SaleReferenceId: reference,
        NextReconcileAt: new Date(Date.now() + 60_000),
        ReconcileAttempts: 1,
        user: user.id,
        Date: new Date(),
      },
    });
    jest
      .spyOn(
        strapi.db.query("api::local-user-wallet-transaction.local-user-wallet-transaction"),
        "create",
      )
      .mockRejectedValueOnce(new Error("injected top-up ledger failure"));

    await expect(
      applyConfirmedWalletTopup(strapi, {
        topupId: topup.id,
        saleReferenceId: reference,
        providerCode: 0,
      }),
    ).rejects.toThrow("injected top-up ledger failure");
    expect(
      Number(
        (
          await strapi.db.query("api::local-user-wallet.local-user-wallet").findOne({
            where: { id: wallet.id },
          })
        ).Balance,
      ),
    ).toBe(2_000);
    expect(
      (
        await strapi.db.query("api::wallet-topup.wallet-topup").findOne({
          where: { id: topup.id },
        })
      ).Status,
    ).toBe("Processing");

    jest.restoreAllMocks();
    await expect(
      applyConfirmedWalletTopup(strapi, {
        topupId: topup.id,
        saleReferenceId: reference,
        providerCode: 0,
      }),
    ).resolves.toEqual({ status: "success", replayed: false });
    expect(
      Number(
        (
          await strapi.db.query("api::local-user-wallet.local-user-wallet").findOne({
            where: { id: wallet.id },
          })
        ).Balance,
      ),
    ).toBe(2_700);

    await strapi.db.query("api::wallet-topup.wallet-topup").delete({ where: { id: topup.id } });
  });
});
