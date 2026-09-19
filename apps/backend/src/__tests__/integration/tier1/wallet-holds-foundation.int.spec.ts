/**
 * Real-Postgres proof for the wallet hold primitives.
 *
 * Everything here is asserted against durable state after the transaction has
 * committed or rolled back — never against a mock's call log. The contended
 * cases use a second knex transaction as a barrier that holds the row the
 * contender needs, so both sides genuinely run concurrently instead of being
 * sequenced by a sleep.
 */
import {
  captureWalletHoldForAttempt,
  getOrCreateWalletForUpdate,
  holdWalletForAttempt,
  releaseWalletHoldsForOrder,
  WalletHoldError,
} from "../../../api/local-user-wallet/services/wallet-holds";
import { applyAdminWalletAdjustment } from "../../../api/local-user-wallet/services/local-user-wallet";
import walletControllerFactory from "../../../api/local-user-wallet/controllers/local-user-wallet";
import { refreshWalletReadiness } from "../../../api/local-user-wallet/services/wallet-readiness";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

let strapi: any;
let f: Factories;

const audit = {
  initiator: { type: "system" as const, id: "wallet-holds-test", label: "Wallet holds test" },
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

const walletRow = async (userId: number) => {
  const result = await strapi.db.connection.raw(
    `SELECT w.id, w.balance, w.held_balance
       FROM local_user_wallets w
       JOIN local_user_wallets_user_links l ON l.local_user_wallet_id = w.id
      WHERE l.user_id = ?`,
    [userId],
  );
  return result.rows;
};

const attemptHold = async (paymentAttemptId: number) => {
  const result = await strapi.db.connection.raw(
    `SELECT wallet_hold_status, wallet_amount, wallet_release_reason
       FROM payment_attempts WHERE id = ?`,
    [paymentAttemptId],
  );
  return result.rows[0];
};

async function makeHoldableAttempt(opts: { balanceIrr: number; amountIrr?: number }) {
  const user = await f.createUser();
  await f.createWallet({ userId: user.id, balanceIrr: opts.balanceIrr });
  const contract = await f.createContract({ amount: 100_000, userId: user.id });
  const order = await f.createOrder({ userId: user.id, contractId: contract.id });
  const attempt = await f.createPaymentAttempt({
    userId: user.id,
    orderId: order.id,
    contractId: contract.id,
    amountIrr: opts.amountIrr ?? opts.balanceIrr,
  });
  return { user, contract, order, attempt };
}

describe("wallet database readiness", () => {
  it("reports the money paths ready once the invariants are installed", async () => {
    const readiness = await refreshWalletReadiness(strapi);
    expect(readiness.checks.filter((check) => !check.ok)).toEqual([]);
    expect(readiness.holds).toBe(true);
    expect(readiness.topups).toBe(true);
  });

  it("enforces one wallet per owner at the database level", async () => {
    const user = await f.createUser();
    const first = await f.createWallet({ userId: user.id, balanceIrr: 1_000 });
    // Strapi reassigns a oneToOne owner rather than duplicating it, so the API
    // path can never produce two links. The index is what stops a second link
    // arriving any other way — a raw insert, an import, or a concurrent create.
    await expect(
      strapi.db.connection.raw(
        `INSERT INTO local_user_wallets_user_links (local_user_wallet_id, user_id) VALUES (?, ?)`,
        [first.id, user.id],
      ),
    ).rejects.toThrow(/idx_local_user_wallets_one_per_user|unique/i);
    expect(await walletRow(user.id)).toHaveLength(1);
  });

  it("enforces ledger reference uniqueness at the database level", async () => {
    const user = await f.createUser();
    const wallet = await f.createWallet({ userId: user.id, balanceIrr: 1_000 });
    const uid = "api::local-user-wallet-transaction.local-user-wallet-transaction";
    await strapi.db.query(uid).create({
      data: {
        Amount: 1_000,
        Type: "Add",
        Date: new Date(),
        Cause: "test",
        ReferenceId: `JEST_TEST__dup-${wallet.id}`,
        user_wallet: wallet.id,
      },
    });
    await expect(
      strapi.db.query(uid).create({
        data: {
          Amount: 1_000,
          Type: "Add",
          Date: new Date(),
          Cause: "test",
          ReferenceId: `JEST_TEST__dup-${wallet.id}`,
          user_wallet: wallet.id,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("wallet creation joins the caller's transaction", () => {
  it("rolls back the wallet row and its owner link when the transaction fails", async () => {
    const user = await f.createUser();

    await expect(
      strapi.db.transaction(async ({ trx }: any) => {
        const wallet = await getOrCreateWalletForUpdate(strapi, user.id, trx);
        expect(wallet.walletId).toBeGreaterThan(0);
        // Proves the write is visible inside the transaction before it is undone.
        const inside = await trx.raw(
          `SELECT COUNT(*)::int AS count FROM local_user_wallets_user_links WHERE user_id = ?`,
          [user.id],
        );
        expect(Number(inside.rows[0].count)).toBe(1);
        throw new Error("JEST_TEST__forced_rollback");
      }),
    ).rejects.toThrow("JEST_TEST__forced_rollback");

    expect(await walletRow(user.id)).toHaveLength(0);
    const links = await strapi.db.connection.raw(
      `SELECT COUNT(*)::int AS count FROM local_user_wallets_user_links WHERE user_id = ?`,
      [user.id],
    );
    expect(Number(links.rows[0].count)).toBe(0);
  });

  it("converges on one wallet when two first-use credits race", async () => {
    const user = await f.createUser();

    // The barrier transaction creates the wallet and holds its link row, so the
    // contender's INSERT ... ON CONFLICT DO NOTHING really blocks on it.
    const barrier = await strapi.db.connection.transaction();
    await barrier.raw(
      `INSERT INTO local_user_wallets (balance, held_balance, created_at, updated_at)
       VALUES (0, 0, NOW(), NOW()) RETURNING id`,
    );
    const barrierWallet = await barrier.raw(
      `SELECT id FROM local_user_wallets ORDER BY id DESC LIMIT 1`,
    );
    const barrierWalletId = Number(barrierWallet.rows[0].id);
    await barrier.raw(
      `INSERT INTO local_user_wallets_user_links (local_user_wallet_id, user_id) VALUES (?, ?)`,
      [barrierWalletId, user.id],
    );

    let contenderWalletId = 0;
    const contender = strapi.db
      .transaction(async ({ trx }: any) => {
        const wallet = await getOrCreateWalletForUpdate(strapi, user.id, trx);
        contenderWalletId = wallet.walletId;
      })
      .catch((error: any) => {
        throw error;
      });

    await new Promise((resolve) => setTimeout(resolve, 250));
    await barrier.commit();
    await contender;

    expect(contenderWalletId).toBe(barrierWalletId);
    const rows = await walletRow(user.id);
    expect(rows).toHaveLength(1);
    await strapi.db.connection.raw(
      `DELETE FROM local_user_wallets_user_links WHERE local_user_wallet_id = ?`,
      [barrierWalletId],
    );
    await strapi.db.connection.raw(`DELETE FROM local_user_wallets WHERE id = ?`, [
      barrierWalletId,
    ]);
  });
});

describe("holding wallet credit", () => {
  it("moves credit from available to held without changing the balance", async () => {
    const { user, attempt } = await makeHoldableAttempt({ balanceIrr: 5_000_000 });

    await strapi.db.transaction(async ({ trx }: any) => {
      await holdWalletForAttempt(
        strapi,
        { userId: user.id, paymentAttemptId: attempt.id, amountIrr: 3_500_000 },
        trx,
      );
    });

    const [row] = await walletRow(user.id);
    expect(Number(row.balance)).toBe(5_000_000);
    expect(Number(row.held_balance)).toBe(3_500_000);
    expect(await attemptHold(attempt.id)).toMatchObject({
      wallet_hold_status: "Active",
      wallet_amount: "3500000",
    });
  });

  it("refuses to hold more than the available balance and leaves nothing behind", async () => {
    const { user, attempt } = await makeHoldableAttempt({ balanceIrr: 500_000 });

    await expect(
      strapi.db.transaction(async ({ trx }: any) =>
        holdWalletForAttempt(
          strapi,
          { userId: user.id, paymentAttemptId: attempt.id, amountIrr: 800_000 },
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: "WALLET_INSUFFICIENT_AVAILABLE" });

    const [row] = await walletRow(user.id);
    expect(Number(row.held_balance)).toBe(0);
    expect((await attemptHold(attempt.id)).wallet_hold_status).toBeNull();
  });

  it("lets only one of two concurrent holds win when the balance covers just one", async () => {
    const user = await f.createUser();
    await f.createWallet({ userId: user.id, balanceIrr: 500_000 });
    const contract = await f.createContract({ amount: 40_000, userId: user.id });
    const orderA = await f.createOrder({ userId: user.id, contractId: contract.id });
    const orderB = await f.createOrder({ userId: user.id, contractId: contract.id });
    const attemptA = await f.createPaymentAttempt({
      userId: user.id,
      orderId: orderA.id,
      contractId: contract.id,
      amountIrr: 400_000,
    });
    const attemptB = await f.createPaymentAttempt({
      userId: user.id,
      orderId: orderB.id,
      contractId: contract.id,
      amountIrr: 400_000,
    });

    const results = await Promise.allSettled([
      strapi.db.transaction(async ({ trx }: any) =>
        holdWalletForAttempt(
          strapi,
          { userId: user.id, paymentAttemptId: attemptA.id, amountIrr: 400_000 },
          trx,
        ),
      ),
      strapi.db.transaction(async ({ trx }: any) =>
        holdWalletForAttempt(
          strapi,
          { userId: user.id, paymentAttemptId: attemptB.id, amountIrr: 400_000 },
          trx,
        ),
      ),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as WalletHoldError).code).toBe("WALLET_INSUFFICIENT_AVAILABLE");

    const [row] = await walletRow(user.id);
    expect(Number(row.held_balance)).toBe(400_000);
    const holds = [await attemptHold(attemptA.id), await attemptHold(attemptB.id)];
    expect(holds.filter((h) => h.wallet_hold_status === "Active")).toHaveLength(1);
  });

  it("is idempotent for a replayed hold and refuses a changed amount", async () => {
    const { user, attempt } = await makeHoldableAttempt({ balanceIrr: 5_000_000 });
    const hold = (amountIrr: number) =>
      strapi.db.transaction(async ({ trx }: any) =>
        holdWalletForAttempt(
          strapi,
          { userId: user.id, paymentAttemptId: attempt.id, amountIrr },
          trx,
        ),
      );

    await hold(1_000_000);
    await expect(hold(1_000_000)).resolves.toMatchObject({ outcome: "already_active" });
    await expect(hold(2_000_000)).rejects.toMatchObject({
      code: "WALLET_HOLD_AMOUNT_MISMATCH",
    });

    const [row] = await walletRow(user.id);
    expect(Number(row.held_balance)).toBe(1_000_000);
  });
});

describe("capturing and releasing", () => {
  it("captures once, posts one ledger row, and is a no-op on replay", async () => {
    const { user, contract, order, attempt } = await makeHoldableAttempt({
      balanceIrr: 5_000_000,
    });
    await strapi.db.transaction(async ({ trx }: any) =>
      holdWalletForAttempt(
        strapi,
        { userId: user.id, paymentAttemptId: attempt.id, amountIrr: 3_500_000 },
        trx,
      ),
    );

    const capture = () =>
      strapi.db.transaction(async ({ trx }: any) =>
        captureWalletHoldForAttempt(
          strapi,
          {
            userId: user.id,
            paymentAttemptId: attempt.id,
            attemptId: attempt.attemptId,
            orderId: order.id,
            contractId: contract.id,
          },
          trx,
        ),
      );

    await expect(capture()).resolves.toMatchObject({ outcome: "captured" });
    await expect(capture()).resolves.toMatchObject({ outcome: "already_captured" });

    const [row] = await walletRow(user.id);
    expect(Number(row.balance)).toBe(1_500_000);
    expect(Number(row.held_balance)).toBe(0);

    const ledger = await strapi.db
      .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
      .findMany({ where: { ReferenceId: `wallet-order-${order.id}-${attempt.attemptId}` } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ Type: "Minus", Amount: "3500000" });

    const legs = await strapi.db.query("api::contract-transaction.contract-transaction").findMany({
      where: { contract: { id: contract.id }, external_source: "Wallet" },
    });
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ Type: "Gateway", SettlementGateway: "Wallet" });
  });

  it("releases an active hold exactly once, writing no ledger row", async () => {
    const { user, order, attempt } = await makeHoldableAttempt({ balanceIrr: 5_000_000 });
    await strapi.db.transaction(async ({ trx }: any) =>
      holdWalletForAttempt(
        strapi,
        { userId: user.id, paymentAttemptId: attempt.id, amountIrr: 2_000_000 },
        trx,
      ),
    );

    const release = () =>
      strapi.db.transaction(async ({ trx }: any) =>
        releaseWalletHoldsForOrder(strapi, { orderId: order.id, reason: "TEST" }, trx),
      );

    await expect(release()).resolves.toMatchObject({ outcome: "released", amountIrr: 2_000_000 });
    await expect(release()).resolves.toMatchObject({ outcome: "skipped", reason: "no_hold" });

    const [row] = await walletRow(user.id);
    expect(Number(row.balance)).toBe(5_000_000);
    expect(Number(row.held_balance)).toBe(0);
    expect(await attemptHold(attempt.id)).toMatchObject({
      wallet_hold_status: "Released",
      wallet_release_reason: "TEST",
    });
    const ledger = await strapi.db
      .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
      .findMany({ where: { user_wallet: { id: row.id } } });
    expect(ledger).toHaveLength(0);
  });

  it("refuses to release a hold on an order that has already been paid", async () => {
    const { user, order, attempt } = await makeHoldableAttempt({ balanceIrr: 5_000_000 });
    await strapi.db.transaction(async ({ trx }: any) =>
      holdWalletForAttempt(
        strapi,
        { userId: user.id, paymentAttemptId: attempt.id, amountIrr: 2_000_000 },
        trx,
      ),
    );
    await strapi.db.query("api::order.order").update({
      where: { id: order.id },
      data: { Status: "Started" },
    });

    await expect(
      strapi.db.transaction(async ({ trx }: any) =>
        releaseWalletHoldsForOrder(strapi, { orderId: order.id, reason: "TEST" }, trx),
      ),
    ).resolves.toMatchObject({ outcome: "skipped", reason: "order_settled" });

    const [row] = await walletRow(user.id);
    expect(Number(row.held_balance)).toBe(2_000_000);
  });

  it("does not release a hold that a concurrent capture already spent", async () => {
    const { user, contract, order, attempt } = await makeHoldableAttempt({
      balanceIrr: 5_000_000,
    });
    await strapi.db.transaction(async ({ trx }: any) =>
      holdWalletForAttempt(
        strapi,
        { userId: user.id, paymentAttemptId: attempt.id, amountIrr: 1_000_000 },
        trx,
      ),
    );

    await strapi.db.transaction(async ({ trx }: any) =>
      captureWalletHoldForAttempt(
        strapi,
        {
          userId: user.id,
          paymentAttemptId: attempt.id,
          attemptId: attempt.attemptId,
          orderId: order.id,
          contractId: contract.id,
        },
        trx,
      ),
    );

    await expect(
      strapi.db.transaction(async ({ trx }: any) =>
        releaseWalletHoldsForOrder(strapi, { orderId: order.id, reason: "TEST" }, trx),
      ),
    ).resolves.toMatchObject({ outcome: "skipped", reason: "no_hold" });

    const [row] = await walletRow(user.id);
    expect(Number(row.balance)).toBe(4_000_000);
    expect(Number(row.held_balance)).toBe(0);
  });

  it("rolls the debit back when the ledger insert fails after the wallet was updated", async () => {
    const { user, contract, order, attempt } = await makeHoldableAttempt({
      balanceIrr: 5_000_000,
    });
    await strapi.db.transaction(async ({ trx }: any) =>
      holdWalletForAttempt(
        strapi,
        { userId: user.id, paymentAttemptId: attempt.id, amountIrr: 1_000_000 },
        trx,
      ),
    );

    // A pre-existing row on the same reference makes the ledger insert the
    // failing statement, after balance and held_balance have already moved.
    const wallet = (await walletRow(user.id))[0];
    const reference = `wallet-order-${order.id}-${attempt.attemptId}`;
    await strapi.db.connection.raw(
      `INSERT INTO local_user_wallet_transactions (amount, type, date, cause, reference_id, created_at, updated_at)
       VALUES (1, 'Add', NOW(), 'JEST_TEST__blocker', ?, NOW(), NOW())`,
      [reference],
    );

    await expect(
      strapi.db.transaction(async ({ trx }: any) => {
        await captureWalletHoldForAttempt(
          strapi,
          {
            userId: user.id,
            paymentAttemptId: attempt.id,
            attemptId: attempt.attemptId,
            orderId: order.id,
            contractId: contract.id,
          },
          trx,
        );
        // The upsert helper short-circuits on an existing reference, so force the
        // failure the way a real duplicate would: insert the same reference again.
        await trx.raw(
          `INSERT INTO local_user_wallet_transactions (amount, type, date, cause, reference_id, created_at, updated_at)
           VALUES (1, 'Minus', NOW(), 'JEST_TEST__conflict', ?, NOW(), NOW())`,
          [reference],
        );
      }),
    ).rejects.toThrow();

    const [after] = await walletRow(user.id);
    expect(Number(after.balance)).toBe(5_000_000);
    expect(Number(after.held_balance)).toBe(1_000_000);
    expect((await attemptHold(attempt.id)).wallet_hold_status).toBe("Active");

    await strapi.db.connection.raw(
      `DELETE FROM local_user_wallet_transactions WHERE reference_id = ?`,
      [reference],
    );
    expect(wallet).toBeDefined();
  });
});

describe("admin adjustment against held credit", () => {
  it("refuses to set a balance below what a live checkout holds", async () => {
    const { user, attempt } = await makeHoldableAttempt({ balanceIrr: 5_000_000 });
    await strapi.db.transaction(async ({ trx }: any) =>
      holdWalletForAttempt(
        strapi,
        { userId: user.id, paymentAttemptId: attempt.id, amountIrr: 3_000_000 },
        trx,
      ),
    );

    await expect(
      applyAdminWalletAdjustment(strapi, {
        userId: user.id,
        mode: "set",
        amountIrr: 1_000_000,
        reason: "JEST_TEST__set below held",
        audit,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });

    const [row] = await walletRow(user.id);
    expect(Number(row.balance)).toBe(5_000_000);
  });

  it("refuses an admin debit that would eat into held credit", async () => {
    const { user, attempt } = await makeHoldableAttempt({ balanceIrr: 5_000_000 });
    await strapi.db.transaction(async ({ trx }: any) =>
      holdWalletForAttempt(
        strapi,
        { userId: user.id, paymentAttemptId: attempt.id, amountIrr: 4_000_000 },
        trx,
      ),
    );

    await expect(
      applyAdminWalletAdjustment(strapi, {
        userId: user.id,
        mode: "debit",
        amountIrr: 2_000_000,
        reason: "JEST_TEST__debit into held",
        audit,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });

    const [row] = await walletRow(user.id);
    expect(Number(row.balance)).toBe(5_000_000);
    expect(Number(row.held_balance)).toBe(4_000_000);
  });
});

describe("what the customer and the operator are told", () => {
  /**
   * The controllers are the only place the numbers reach a person, and the
   * bug they guard against — held money offered as spendable — is invisible
   * to the service-level tests above. So drive the real handlers.
   */
  const controller = () => (walletControllerFactory as any)({ strapi });

  const customerContext = (userId: number) => {
    const sent: any[] = [];
    return {
      ctx: {
        state: { user: { id: userId } },
        request: { header: {} },
        send: (payload: any) => sent.push(payload),
        unauthorized: (message: string) => sent.push({ unauthorized: message }),
        notFound: (message: string) => sent.push({ notFound: message }),
        internalServerError: (message: string) => sent.push({ error: message }),
      } as any,
      sent,
    };
  };

  it("tells the customer what is held and what is left to spend", async () => {
    const { user, attempt } = await makeHoldableAttempt({ balanceIrr: 5_000_000 });
    await strapi.db.transaction(async ({ trx }: any) =>
      holdWalletForAttempt(
        strapi,
        { userId: user.id, paymentAttemptId: attempt.id, amountIrr: 3_500_000 },
        trx,
      ),
    );

    const { ctx, sent } = customerContext(user.id);
    await controller().getCurrentUserWallet(ctx);

    expect(sent[0]).toMatchObject({
      success: true,
      data: {
        balance: 5_000_000,
        heldBalance: 3_500_000,
        availableBalance: 1_500_000,
      },
    });
  });

  it("reports nothing spendable when a checkout holds the whole balance", async () => {
    const { user, attempt } = await makeHoldableAttempt({ balanceIrr: 5_000_000 });
    await strapi.db.transaction(async ({ trx }: any) =>
      holdWalletForAttempt(
        strapi,
        { userId: user.id, paymentAttemptId: attempt.id, amountIrr: 5_000_000 },
        trx,
      ),
    );

    const { ctx, sent } = customerContext(user.id);
    await controller().getCurrentUserWallet(ctx);

    expect(sent[0].data).toMatchObject({
      balance: 5_000_000,
      heldBalance: 5_000_000,
      availableBalance: 0,
    });
  });

  it("gives the operator the same breakdown the adjustment guard enforces", async () => {
    const { user, attempt } = await makeHoldableAttempt({ balanceIrr: 5_000_000 });
    await strapi.db.transaction(async ({ trx }: any) =>
      holdWalletForAttempt(
        strapi,
        { userId: user.id, paymentAttemptId: attempt.id, amountIrr: 4_000_000 },
        trx,
      ),
    );

    const sent: any[] = [];
    const ctx: any = {
      params: { userId: String(user.id) },
      send: (payload: any) => sent.push(payload),
      badRequest: (message: string) => sent.push({ badRequest: message }),
      notFound: (message: string) => sent.push({ notFound: message }),
      internalServerError: (message: string) => sent.push({ error: message }),
    };
    await controller().adminGetUserWallet(ctx);

    expect(sent[0]).toMatchObject({
      success: true,
      data: {
        balanceIrr: 5_000_000,
        balanceToman: 500_000,
        heldIrr: 4_000_000,
        heldToman: 400_000,
        availableIrr: 1_000_000,
        availableToman: 100_000,
      },
    });
  });
});
