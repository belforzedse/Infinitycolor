/**
 * Correlation and state monotonicity for the public wallet top-up callback.
 *
 * `/api/wallet/payment-callback` is unauthenticated, so every field in the body is
 * attacker-controlled. `SaleOrderId` only locates a candidate row; `RefId` — minted by
 * Mellat at bpPayRequest and persisted by chargeIntent — is what ties a callback to one
 * specific attempt.
 *
 * The harness models the wallet_topups row so the guarded `status = 'Pending'` UPDATE is
 * really executed rather than stubbed, which is what makes the duplicate-failure and
 * stale-failure-after-success cases meaningful.
 */
const writeAuditEvent = jest.fn().mockResolvedValue({
  id: 1,
  eventId: "7b95185e-fe3c-4357-b73e-76da20b60ef9",
  deduplicated: false,
});
jest.mock("../../../audit/writer", () => ({
  writeAuditEvent: (...args: any[]) => writeAuditEvent(...args),
}));

import controllerFactory from "../controllers/wallet-topup";

type TopupRow = {
  id: number;
  SaleOrderId: string;
  RefId: string | null;
  Amount: number;
  Status: "Pending" | "Processing" | "Unknown" | "Success" | "Failed" | "Cancelled";
  SaleReferenceId?: string | null;
  NextReconcileAt?: Date | null;
  user: { id: number };
};

function createWorld(topups: TopupRow[]) {
  const walletTransactions: any[] = [];
  const wallet = { id: 900, Balance: 0 };

  const applyStatusCas = (sql: string, bindings: any[]) => {
    if (!/UPDATE wallet_topups/.test(sql)) return null;
    if (/status = 'Failed'/.test(sql)) {
      const row = topups.find((topup) => topup.id === Number(bindings[2]));
      const allowed = bindings.slice(3).map(String);
      if (!row || !allowed.includes(row.Status)) return { rows: [] };
      row.Status = "Failed";
      row.NextReconcileAt = null;
      return { rows: [{ id: row.id }] };
    }
    if (/status = 'Processing'/.test(sql) && /sale_reference_id = \?/.test(sql)) {
      const row = topups.find((topup) => topup.id === Number(bindings[2]));
      if (!row || row.Status !== "Pending") return { rows: [] };
      row.Status = "Processing";
      row.SaleReferenceId = String(bindings[0]);
      row.NextReconcileAt = bindings[1];
      return { rows: [{ id: row.id }] };
    }
    if (/status = 'Unknown'/.test(sql)) {
      const row = topups.find((topup) => topup.id === Number(bindings[3]));
      if (!row || !["Pending", "Processing", "Unknown"].includes(row.Status)) {
        return { rows: [] };
      }
      row.Status = "Unknown";
      row.NextReconcileAt = bindings[0];
      return { rows: [{ id: row.id }] };
    }
    return { rows: [] };
  };

  const mellat = {
    verifyTransaction: jest.fn().mockResolvedValue({ success: true }),
    settleTransaction: jest.fn().mockResolvedValue({ success: true }),
    requestPayment: jest.fn(),
  };

  const strapi: any = {
    log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    entityService: {
      findMany: jest.fn(async (_uid: string, params: any) => {
        const saleOrderId = params?.filters?.SaleOrderId;
        const found = topups.find((topup) => topup.SaleOrderId === saleOrderId);
        return found ? [found] : [];
      }),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => ({ id: 1 })),
    },
    service: jest.fn((uid: string) => {
      if (uid === "api::payment-gateway.mellat-v3") return mellat;
      return undefined;
    }),
    config: { get: jest.fn((_key: string, fallback?: string) => fallback) },
    // createCoreController eagerly proxies the content type; the generated CRUD actions
    // are unused here, only the custom paymentCallback is exercised.
    contentType: jest.fn(() => ({ uid: "api::wallet-topup.wallet-topup", attributes: {} })),
    db: {
      inTransaction: () => false,
      connection: {
        raw: jest.fn(async (sql: string, bindings: any[]) => applyStatusCas(sql, bindings) ?? { rows: [] }),
      },
      transaction: jest.fn(async (cb: any) => {
        const trx = {
          raw: jest.fn(async (sql: string, bindings: any[]) => {
            if (/FROM wallet_topups/.test(sql)) {
              const row = topups.find((topup) => topup.id === Number(bindings[0]));
              return row
                ? {
                    rows: [
                      {
                        id: row.id,
                        amount: row.Amount,
                        status: row.Status,
                        sale_reference_id: row.SaleReferenceId ?? null,
                      },
                    ],
                  }
                : { rows: [] };
            }
            if (/UPDATE local_user_wallets/.test(sql)) {
              wallet.Balance += Number(bindings[0]);
              return { rows: [{ id: wallet.id, balance: wallet.Balance }] };
            }
            return applyStatusCas(sql, bindings) ?? { rows: [] };
          }),
        };
        return cb({ trx });
      }),
      query: jest.fn((uid: string) => {
        if (uid === "api::local-user-wallet-transaction.local-user-wallet-transaction") {
          return {
            findOne: jest.fn(async ({ where }: any) =>
              walletTransactions.find((tx) => tx.ReferenceId === where.ReferenceId) || null,
            ),
            create: jest.fn(async ({ data }: any) => {
              walletTransactions.push(data);
              return { id: walletTransactions.length, ...data };
            }),
          };
        }
        if (uid === "api::local-user-wallet.local-user-wallet") {
          return {
            findOne: jest.fn(async () => wallet),
            create: jest.fn(async () => wallet),
          };
        }
        if (uid === "api::wallet-topup.wallet-topup") {
          return {
            findOne: jest.fn(async ({ where }: any) =>
              topups.find((topup) => topup.id === Number(where.id)) || null,
            ),
            update: jest.fn(async ({ where, data }: any) => {
              const row = topups.find((topup) => topup.id === Number(where.id));
              if (row) Object.assign(row, data);
              return row;
            }),
          };
        }
        throw new Error(`unexpected uid ${uid}`);
      }),
    },
  };

  const controller = (controllerFactory as any)({ strapi });
  return { strapi, controller, topups, wallet, walletTransactions, mellat };
}

const callbackCtx = (body: Record<string, unknown>) => ({
  request: { body },
  redirect: jest.fn(),
});

const lastRedirect = (ctx: any) => ctx.redirect.mock.calls.at(-1)?.[0] ?? "";

const pendingTopup = (overrides: Partial<TopupRow> = {}): TopupRow => ({
  id: 100,
  SaleOrderId: "1700000000100",
  RefId: "MELLAT-REF-100",
  Amount: 1_000_000,
  Status: "Pending",
  user: { id: 7 },
  ...overrides,
});

describe("wallet top-up failure callback correlation", () => {
  beforeEach(() => writeAuditEvent.mockClear());
  it("leaves attempt B untouched when the callback carries attempt A's provider identity", async () => {
    const attemptB = pendingTopup({ id: 200, SaleOrderId: "1700000000200", RefId: "REF-B" });
    const { controller, topups } = createWorld([attemptB]);

    const ctx = callbackCtx({
      ResCode: "17",
      SaleOrderId: "1700000000200",
      RefId: "REF-A",
    });
    await controller.paymentCallback(ctx);

    expect(topups[0].Status).toBe("Pending");
    expect(lastRedirect(ctx)).toContain("reason=unverified");
  });

  it("mutates nothing for a nonexistent attempt", async () => {
    const { controller, strapi } = createWorld([]);

    const ctx = callbackCtx({ ResCode: "17", SaleOrderId: "does-not-exist", RefId: "REF-X" });
    await controller.paymentCallback(ctx);

    expect(strapi.db.connection.raw).not.toHaveBeenCalled();
    expect(lastRedirect(ctx)).toContain("reason=not_found");
  });

  it("transitions exactly once for a correlated failure", async () => {
    const { controller, topups, strapi } = createWorld([pendingTopup()]);

    const ctx = callbackCtx({
      ResCode: "17",
      SaleOrderId: "1700000000100",
      RefId: "MELLAT-REF-100",
    });
    await controller.paymentCallback(ctx);

    expect(topups[0].Status).toBe("Failed");
    const casCalls = strapi.db.connection.raw.mock.calls.filter(([sql]: [string]) =>
      /UPDATE wallet_topups/.test(sql),
    );
    expect(casCalls).toHaveLength(1);
    expect(lastRedirect(ctx)).toContain("status=failure&code=17");
  });

  it("is idempotent under a duplicate failure callback", async () => {
    const { controller, topups, strapi } = createWorld([pendingTopup()]);
    const body = { ResCode: "17", SaleOrderId: "1700000000100", RefId: "MELLAT-REF-100" };

    await controller.paymentCallback(callbackCtx(body));
    await controller.paymentCallback(callbackCtx(body));

    expect(topups[0].Status).toBe("Failed");
    // Both callbacks attempted the CAS; only the first matched a row.
    const casResults = await Promise.all(
      strapi.db.connection.raw.mock.results.map((result: any) => result.value),
    );
    const matched = casResults.filter((result: any) => (result?.rows || []).length === 1);
    expect(matched).toHaveLength(1);
  });

  it("cannot undo a success with a stale failure callback", async () => {
    const settled = pendingTopup({ Status: "Success", SaleReferenceId: "REF-SUCCESS" });
    const { controller, topups } = createWorld([settled]);

    const ctx = callbackCtx({
      ResCode: "17",
      SaleOrderId: "1700000000100",
      RefId: "MELLAT-REF-100",
    });
    await controller.paymentCallback(ctx);

    // Correlated, so the CAS runs — and refuses, because the row is no longer Pending.
    expect(topups[0].Status).toBe("Success");
  });

  it("cannot let an older attempt's callback mutate a newer attempt", async () => {
    const older = pendingTopup({ id: 100, SaleOrderId: "1700000000100", RefId: "REF-OLD" });
    const newer = pendingTopup({ id: 101, SaleOrderId: "1700000000101", RefId: "REF-NEW" });
    const { controller, topups } = createWorld([older, newer]);

    // The old attempt's RefId aimed at the newer attempt's SaleOrderId.
    const ctx = callbackCtx({
      ResCode: "17",
      SaleOrderId: "1700000000101",
      RefId: "REF-OLD",
    });
    await controller.paymentCallback(ctx);

    expect(topups.find((topup) => topup.id === 101)?.Status).toBe("Pending");
    expect(topups.find((topup) => topup.id === 100)?.Status).toBe("Pending");
    expect(lastRedirect(ctx)).toContain("reason=unverified");
  });
});

describe("wallet top-up success callback", () => {
  it("credits the amount from the locked row, never a caller-supplied value", async () => {
    const { controller, wallet, walletTransactions } = createWorld([pendingTopup()]);

    const ctx = callbackCtx({
      ResCode: "0",
      SaleOrderId: "1700000000100",
      SaleReferenceId: "BANK-REF-1",
      RefId: "MELLAT-REF-100",
      // Ignored: the credit is driven by wallet_topups.amount under FOR UPDATE.
      Amount: 999_999_999,
    });
    await controller.paymentCallback(ctx);

    expect(wallet.Balance).toBe(1_000_000);
    expect(walletTransactions).toHaveLength(1);
    expect(walletTransactions[0]).toMatchObject({
      Amount: 1_000_000,
      ReferenceId: "BANK-REF-1",
      Cause: "Wallet Topup",
    });
    expect(lastRedirect(ctx)).toContain("status=success");
  });

  it("refuses to verify when the RefId points at a different attempt", async () => {
    const { controller, mellat, wallet } = createWorld([pendingTopup()]);

    const ctx = callbackCtx({
      ResCode: "0",
      SaleOrderId: "1700000000100",
      SaleReferenceId: "BANK-REF-1",
      RefId: "REF-SOMEONE-ELSE",
    });
    await controller.paymentCallback(ctx);

    expect(mellat.verifyTransaction).not.toHaveBeenCalled();
    expect(mellat.settleTransaction).not.toHaveBeenCalled();
    expect(wallet.Balance).toBe(0);
    expect(lastRedirect(ctx)).toContain("reason=unverified");
  });

  it("still settles a legacy attempt that never persisted a RefId", async () => {
    // chargeIntent's RefId write is best-effort. The bank's own verify/settle on
    // (saleOrderId, saleReferenceId) is authoritative for the constructive path, so a
    // missing local anchor must not strand a real payment.
    const { controller, wallet } = createWorld([pendingTopup({ RefId: null })]);

    const ctx = callbackCtx({
      ResCode: "0",
      SaleOrderId: "1700000000100",
      SaleReferenceId: "BANK-REF-1",
      RefId: "MELLAT-REF-100",
    });
    await controller.paymentCallback(ctx);

    expect(wallet.Balance).toBe(1_000_000);
    expect(lastRedirect(ctx)).toContain("status=success");
  });

  it("credits only once when the same success callback is replayed", async () => {
    const { controller, wallet, walletTransactions, mellat } = createWorld([pendingTopup()]);
    const body = {
      ResCode: "0",
      SaleOrderId: "1700000000100",
      SaleReferenceId: "BANK-REF-1",
      RefId: "MELLAT-REF-100",
    };

    await controller.paymentCallback(callbackCtx(body));
    await controller.paymentCallback(callbackCtx(body));

    expect(wallet.Balance).toBe(1_000_000);
    expect(walletTransactions).toHaveLength(1);
    expect(mellat.verifyTransaction).toHaveBeenCalledTimes(1);
    expect(mellat.settleTransaction).toHaveBeenCalledTimes(1);
  });

  it("performs provider I/O before opening the local credit transaction", async () => {
    const world = createWorld([pendingTopup()]);
    const events: string[] = [];
    world.mellat.verifyTransaction.mockImplementation(async () => {
      events.push("verify");
      return { success: true, resCode: 0 };
    });
    world.mellat.settleTransaction.mockImplementation(async () => {
      events.push("settle");
      return { success: true, resCode: 0 };
    });
    world.strapi.db.transaction.mockImplementation(async (callback: any) => {
      events.push("transaction");
      const trx = {
        raw: jest.fn(async (sql: string, bindings: any[]) => {
          if (/FROM wallet_topups/.test(sql)) {
            const row = world.topups[0];
            return {
              rows: [{
                id: row.id,
                amount: row.Amount,
                status: row.Status,
                sale_reference_id: row.SaleReferenceId,
              }],
            };
          }
          if (/UPDATE local_user_wallets/.test(sql)) {
            world.wallet.Balance += Number(bindings[0]);
            return { rows: [{ id: world.wallet.id, balance: world.wallet.Balance }] };
          }
          return { rows: [] };
        }),
      };
      return callback({ trx });
    });

    await world.controller.paymentCallback(callbackCtx({
      ResCode: "0",
      SaleOrderId: "1700000000100",
      SaleReferenceId: "BANK-REF-ORDER",
      RefId: "MELLAT-REF-100",
    }));

    expect(events).toEqual(["verify", "settle", "transaction"]);
  });

  it("leaves a sweepable Unknown when provider settlement succeeds but local credit fails", async () => {
    const world = createWorld([pendingTopup()]);
    world.strapi.db.transaction.mockRejectedValueOnce(new Error("ledger insert failed"));
    const ctx = callbackCtx({
      ResCode: "0",
      SaleOrderId: "1700000000100",
      SaleReferenceId: "BANK-REF-LOCAL-FAIL",
      RefId: "MELLAT-REF-100",
    });

    await world.controller.paymentCallback(ctx);

    expect(world.topups[0].Status).toBe("Unknown");
    expect(world.topups[0].NextReconcileAt).toBeInstanceOf(Date);
    expect(world.wallet.Balance).toBe(0);
    expect(lastRedirect(ctx)).toContain("status=pending");
  });
});
