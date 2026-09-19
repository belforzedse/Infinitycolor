/**
 * Wallet top-ups against a real Postgres.
 *
 * The properties that matter are the ones a mock cannot establish: that two
 * simultaneous requests carrying the same idempotency key produce one intent,
 * that the pending cap holds when the checks overlap, and that a confirmed
 * top-up credits exactly once no matter how many callbacks and reconciler ticks
 * deliver it.
 */
import {
  applyConfirmedWalletTopup,
  createWalletTopupIntent,
  expireAbandonedWalletTopups,
  findWalletTopupCredit,
  listWalletTopupsNeedingReview,
  markWalletTopupRedirected,
  markWalletTopupUnknown,
  WalletTopupIntentError,
} from "../../../api/wallet-topup/services/wallet-topup";
import { refreshWalletReadiness } from "../../../api/local-user-wallet/services/wallet-readiness";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

let strapi: any;
let f: Factories;

const AMOUNT_IRR = 3_000_000; // 300,000 toman

beforeAll(async () => {
  process.env.WALLET_TOPUP_ENABLED = "true";
  process.env.WALLET_TOPUP_GATEWAYS = "mellat";
  process.env.WALLET_TOPUP_MAX_PENDING = "2";
  strapi = await setupStrapi();
  await refreshWalletReadiness(strapi);
});

afterAll(async () => {
  await teardownStrapi();
  delete process.env.WALLET_TOPUP_ENABLED;
  delete process.env.WALLET_TOPUP_GATEWAYS;
  delete process.env.WALLET_TOPUP_MAX_PENDING;
});

beforeEach(() => {
  f = makeFactories(strapi);
});

afterEach(async () => {
  await strapi.db.connection.raw(
    `DELETE FROM wallet_topups_user_links WHERE wallet_topup_id IN (
       SELECT id FROM wallet_topups WHERE sale_order_id IS NOT NULL
     )`,
  );
  await strapi.db.connection.raw(`DELETE FROM wallet_topups`);
  await f.cleanup();
});

const walletOf = async (userId: number) => {
  const result = await strapi.db.connection.raw(
    `SELECT w.id, w.balance, w.held_balance
       FROM local_user_wallets w
       JOIN local_user_wallets_user_links l ON l.local_user_wallet_id = w.id
      WHERE l.user_id = ?`,
    [userId],
  );
  const row = result.rows[0];
  return row
    ? { id: Number(row.id), balanceIrr: Number(row.balance), heldIrr: Number(row.held_balance) }
    : null;
};

const ledgerRows = async (userId: number) => {
  const result = await strapi.db.connection.raw(
    `SELECT t.amount, t.type, t.reference_id
       FROM local_user_wallet_transactions t
       JOIN local_user_wallet_transactions_user_wallet_links l
         ON l.local_user_wallet_transaction_id = t.id
       JOIN local_user_wallets_user_links ul
         ON ul.local_user_wallet_id = l.local_user_wallet_id
      WHERE ul.user_id = ?`,
    [userId],
  );
  return result.rows;
};

describe("top-up intent creation", () => {
  it("returns one intent for two simultaneous requests sharing an idempotency key", async () => {
    const user = await f.createUser();

    const results = await Promise.all([
      createWalletTopupIntent(strapi, {
        userId: user.id,
        amountIrr: AMOUNT_IRR,
        gateway: "Mellat",
        idempotencyKey: "same-key",
      }),
      createWalletTopupIntent(strapi, {
        userId: user.id,
        amountIrr: AMOUNT_IRR,
        gateway: "Mellat",
        idempotencyKey: "same-key",
      }),
    ]);

    const ids = new Set(results.map((result) => Number(result.topup.id)));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.reused)).toHaveLength(1);

    const stored = await strapi.db.connection.raw(
      `SELECT COUNT(*)::int AS count FROM wallet_topups`,
    );
    expect(Number(stored.rows[0].count)).toBe(1);
  });

  it("refuses the same key with different parameters", async () => {
    const user = await f.createUser();
    await createWalletTopupIntent(strapi, {
      userId: user.id,
      amountIrr: AMOUNT_IRR,
      gateway: "Mellat",
      idempotencyKey: "key-1",
    });

    await expect(
      createWalletTopupIntent(strapi, {
        userId: user.id,
        amountIrr: AMOUNT_IRR * 2,
        gateway: "Mellat",
        idempotencyKey: "key-1",
      }),
    ).rejects.toMatchObject({ code: "WALLET_TOPUP_IDEMPOTENCY_CONFLICT" });
  });

  it("holds the pending cap when three requests check it at the same time", async () => {
    const user = await f.createUser();

    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        createWalletTopupIntent(strapi, {
          userId: user.id,
          amountIrr: AMOUNT_IRR,
          gateway: "Mellat",
        }),
      ),
    );

    // Counting and inserting happen inside one per-customer advisory lock, so
    // the third cannot observe "one below the cap" alongside the second.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as WalletTopupIntentError).code).toBe("WALLET_TOPUP_PENDING_LIMIT");

    const stored = await strapi.db.connection.raw(
      `SELECT COUNT(*)::int AS count FROM wallet_topups`,
    );
    expect(Number(stored.rows[0].count)).toBe(2);
  });

  it("does not let abandoned intents lock a customer out of the cap forever", async () => {
    const user = await f.createUser();
    for (let index = 0; index < 2; index += 1) {
      const { topup } = await createWalletTopupIntent(strapi, {
        userId: user.id,
        amountIrr: AMOUNT_IRR,
        gateway: "Mellat",
      });
      // Reached the bank and was abandoned there: it keeps its provider handle,
      // so the sweep will never close it and a late callback can still arrive.
      await markWalletTopupRedirected(strapi, {
        topupId: Number(topup.id),
        providerReference: `MELLAT-ABANDONED-${index}`,
        initiationToken: `MELLAT-ABANDONED-${index}`,
      });
    }
    await strapi.db.connection.raw(
      `UPDATE wallet_topups SET expires_at = NOW() - INTERVAL '2 hours'`,
    );

    // The cap is about live intents, not about rows that still exist.
    await expect(
      createWalletTopupIntent(strapi, {
        userId: user.id,
        amountIrr: AMOUNT_IRR,
        gateway: "Mellat",
      }),
    ).resolves.toMatchObject({ reused: false });

    const stillPending = await strapi.db.connection.raw(
      `SELECT COUNT(*)::int AS count FROM wallet_topups WHERE status = 'Pending'`,
    );
    expect(Number(stillPending.rows[0].count)).toBe(3);
  });

  it("gives every intent a distinct, database-unique reference", async () => {
    const users = await Promise.all([f.createUser(), f.createUser(), f.createUser()]);
    const created = await Promise.all(
      users.map((user) =>
        createWalletTopupIntent(strapi, {
          userId: user.id,
          amountIrr: AMOUNT_IRR,
          gateway: "Mellat",
        }),
      ),
    );

    const references = created.map((entry) => String(entry.topup.SaleOrderId));
    expect(new Set(references).size).toBe(references.length);

    // And the database refuses a duplicate however it arrives.
    await expect(
      strapi.db.connection.raw(
        `INSERT INTO wallet_topups (amount, status, sale_order_id, created_at, updated_at)
         VALUES (1, 'Pending', ?, NOW(), NOW())`,
        [references[0]],
      ),
    ).rejects.toThrow(/idx_wallet_topups_sale_order_id|unique/i);
  });
});

describe("crediting a confirmed top-up", () => {
  it("credits exactly once when callback and reconciler both deliver it", async () => {
    const user = await f.createUser();
    const { topup } = await createWalletTopupIntent(strapi, {
      userId: user.id,
      amountIrr: AMOUNT_IRR,
      gateway: "Mellat",
    });
    await markWalletTopupRedirected(strapi, {
      topupId: Number(topup.id),
      providerReference: "MELLAT-REF-1",
      initiationToken: "MELLAT-REF-1",
    });

    const confirm = () =>
      applyConfirmedWalletTopup(strapi, {
        topupId: Number(topup.id),
        saleReferenceId: "BANK-SETTLEMENT-1",
        providerCode: 0,
      });

    const outcomes = await Promise.allSettled([confirm(), confirm()]);
    // Whichever ordering the two take, the money moves once.
    expect(outcomes.filter((o) => o.status === "fulfilled").length).toBeGreaterThanOrEqual(1);

    await confirm();

    const wallet = await walletOf(user.id);
    expect(wallet?.balanceIrr).toBe(AMOUNT_IRR);
    expect(wallet?.heldIrr).toBe(0);

    const ledger = await ledgerRows(user.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: "Add",
      amount: String(AMOUNT_IRR),
      reference_id: "wallet-topup-Mellat-BANK-SETTLEMENT-1",
    });

    const row = await strapi.db.connection.raw(
      `SELECT status, ledger_reference_id FROM wallet_topups WHERE id = ?`,
      [Number(topup.id)],
    );
    expect(row.rows[0]).toMatchObject({
      status: "Success",
      ledger_reference_id: "wallet-topup-Mellat-BANK-SETTLEMENT-1",
    });
  });

  it("recognises a credit posted under the legacy bare reference", async () => {
    const user = await f.createUser();
    const wallet = await f.createWallet({ userId: user.id, balanceIrr: 0 });
    await strapi.db.query("api::local-user-wallet-transaction.local-user-wallet-transaction").create({
      data: {
        Amount: AMOUNT_IRR,
        Type: "Add",
        Date: new Date(),
        Cause: "Wallet Topup",
        // How rows were keyed before top-ups were multi-gateway.
        ReferenceId: "LEGACY-REF-9",
        user_wallet: wallet.id,
      },
    });

    expect(await findWalletTopupCredit(strapi, "LEGACY-REF-9", undefined, "Mellat")).toBeTruthy();
  });

  it("is race-safe for a customer's very first credit", async () => {
    const user = await f.createUser();
    const intents = await Promise.all([
      createWalletTopupIntent(strapi, {
        userId: user.id,
        amountIrr: AMOUNT_IRR,
        gateway: "Mellat",
      }),
      createWalletTopupIntent(strapi, {
        userId: user.id,
        amountIrr: AMOUNT_IRR,
        gateway: "Mellat",
      }),
    ]);

    // Neither customer has a wallet row yet; both credits must converge on one.
    await Promise.all(
      intents.map((entry, index) =>
        applyConfirmedWalletTopup(strapi, {
          topupId: Number(entry.topup.id),
          saleReferenceId: `FIRST-USE-${index}`,
          providerCode: 0,
        }),
      ),
    );

    const rows = await strapi.db.connection.raw(
      `SELECT COUNT(*)::int AS count FROM local_user_wallets_user_links WHERE user_id = ?`,
      [user.id],
    );
    expect(Number(rows.rows[0].count)).toBe(1);
    expect((await walletOf(user.id))?.balanceIrr).toBe(AMOUNT_IRR * 2);
  });
});

describe("abandoned intents", () => {
  it("closes only intents that never reached a provider", async () => {
    const user = await f.createUser();
    const abandoned = await createWalletTopupIntent(strapi, {
      userId: user.id,
      amountIrr: AMOUNT_IRR,
      gateway: "Mellat",
    });
    const dispatched = await createWalletTopupIntent(strapi, {
      userId: user.id,
      amountIrr: AMOUNT_IRR,
      gateway: "Mellat",
    });
    await markWalletTopupRedirected(strapi, {
      topupId: Number(dispatched.topup.id),
      providerReference: "MELLAT-REF-2",
      initiationToken: "MELLAT-REF-2",
    });

    // Both are long past their local TTL.
    await strapi.db.connection.raw(
      `UPDATE wallet_topups SET expires_at = NOW() - INTERVAL '2 hours'`,
    );

    const swept = await expireAbandonedWalletTopups(strapi);
    expect(swept.cancelled).toBe(1);

    const statuses = await strapi.db.connection.raw(
      `SELECT id, status FROM wallet_topups ORDER BY id`,
    );
    const byId = Object.fromEntries(
      statuses.rows.map((row: any) => [Number(row.id), row.status]),
    );
    expect(byId[Number(abandoned.topup.id)]).toBe("Cancelled");
    // An elapsed local clock says nothing about what happened at the bank.
    expect(byId[Number(dispatched.topup.id)]).toBe("Pending");
  });
});

describe("intents the ladder gave up on", () => {
  /**
   * `Unknown` with no next attempt is the end of automatic recovery. Money may
   * have left the customer's account and nothing will look again, so an
   * operator has to. The queue that shows them must not miss one, and must not
   * pad itself with rows something is still working on.
   */
  it("surfaces exactly the intents nothing is going to resolve on its own", async () => {
    // Separate customers, because the queue is the store's, not one shopper's
    // — and because three live intents for one person hit the pending cap.
    const user = await f.createUser();
    const other = await f.createUser();
    const third = await f.createUser();

    const stranded = await createWalletTopupIntent(strapi, {
      userId: user.id,
      amountIrr: AMOUNT_IRR,
      gateway: "Mellat",
    });
    await markWalletTopupRedirected(strapi, {
      topupId: Number(stranded.topup.id),
      providerReference: "MELLAT-STRANDED",
      initiationToken: "MELLAT-STRANDED",
    });
    // The twelfth attempt is the last one the ladder schedules.
    await markWalletTopupUnknown(strapi, {
      topupId: Number(stranded.topup.id),
      attempt: 12,
      providerCode: 21,
      error: "invalid transaction",
    });

    // Still on the ladder: a retry is scheduled, so nobody needs to be paged.
    const retrying = await createWalletTopupIntent(strapi, {
      userId: other.id,
      amountIrr: AMOUNT_IRR,
      gateway: "Mellat",
    });
    await markWalletTopupUnknown(strapi, {
      topupId: Number(retrying.topup.id),
      attempt: 1,
      providerCode: 21,
      error: "provider timed out",
    });

    // Still waiting on the customer.
    await createWalletTopupIntent(strapi, {
      userId: third.id,
      amountIrr: AMOUNT_IRR,
      gateway: "Mellat",
    });

    const queue = await listWalletTopupsNeedingReview(strapi);
    const ids = queue.map((row: any) => Number(row.id));
    expect(ids).toContain(Number(stranded.topup.id));
    expect(ids).not.toContain(Number(retrying.topup.id));

    const row = queue.find((entry: any) => Number(entry.id) === Number(stranded.topup.id));
    // The operator needs the owner and the provider's own words to act on it.
    expect(Number(row.user_id)).toBe(user.id);
    expect(String(row.provider_reference)).toBe("MELLAT-STRANDED");
    expect(String(row.last_provider_error)).toBe("invalid transaction");
    // The owner is joined through the project's renamed users table, not the
    // `up_users` Strapi would default to.
    expect(String(row.owner_username || "")).toBe(String(user.username));
  });
});
