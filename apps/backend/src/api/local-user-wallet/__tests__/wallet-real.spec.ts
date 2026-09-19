/**
 * Wallet Operations Tests - REAL IMPLEMENTATION
 * Tests actual wallet balance queries and topup flow
 */

// Simplify Strapi controller factory for tests
jest.mock('@strapi/strapi', () => ({
  factories: {
    createCoreController: (_uid: string, extension: any) => (params: any) => extension(params),
    createCoreService: () => ({}),
  },
}));

import { createStrapiMock, mockContext, mockUser } from '../../../__tests__/mocks/factories';
import walletRoutes from '../routes/custom-router';

import { __setWalletReadinessForTests } from '../services/wallet-readiness';

/**
 * Wallet capabilities are the operator flag AND the verified database
 * prerequisites, so a unit test has to state both. Readiness is a process-wide
 * cache refreshed at bootstrap; here it is set directly.
 */
const setWalletTopupReadiness = (topups: boolean) =>
  __setWalletReadinessForTests({
    evaluatedAt: new Date().toISOString(),
    holds: topups,
    topups,
    checks: [],
  });

describe('Wallet Operations - Real Implementation', () => {
  let mockStrapi: any;
  let walletController: any;
  let topupController: any;
  let mellatService: any;
  let walletModule: any;
  let topupModule: any;

  const installTopupTransactionMocks = ({
    topup,
    wallet,
    existingTransactions = [],
  }: {
    topup: any;
    wallet: any;
    existingTransactions?: any[];
  }) => {
    const walletQuery = mockStrapi.db.query('api::local-user-wallet.local-user-wallet');
    const topupQuery = mockStrapi.db.query('api::wallet-topup.wallet-topup');
    const transactionQuery = mockStrapi.db.query(
      'api::local-user-wallet-transaction.local-user-wallet-transaction'
    );
    const transactions = existingTransactions;
    let transactionQueue = Promise.resolve();

    walletQuery.findOne.mockResolvedValue(wallet);

    // The controller resolves an intent by our minted reference, or — for
    // providers that do not echo one — by the handle it stored at initiation.
    topupQuery.findOne.mockImplementation(async (args: any = {}) => {
      const where = args?.where || {};
      if (where.SaleOrderId !== undefined) {
        return String(topup.SaleOrderId) === String(where.SaleOrderId) ? topup : null;
      }
      if (where.ProviderReference !== undefined) {
        return String(topup.ProviderReference ?? "") === String(where.ProviderReference)
          ? topup
          : null;
      }
      return topup;
    });

    mockStrapi.db.connection.raw.mockImplementation(async (sql: string, bindings: any[]) => {
      if (sql.includes("SET status = 'Processing'")) {
        if (topup.Status !== 'Pending') return { rows: [] };
        topup.Status = 'Processing';
        topup.SaleReferenceId = bindings[0];
        topup.NextReconcileAt = bindings[1];
        return { rows: [{ id: topup.id }] };
      }
      return { rows: [] };
    });

    transactionQuery.findOne.mockImplementation(async ({ where }: any) => {
      const wanted = where?.ReferenceId?.$in ?? [where?.ReferenceId];
      return transactions.find((tx: any) => wanted.includes(tx.ReferenceId)) || null;
    });

    transactionQuery.create.mockImplementation(async ({ data }: any) => {
      if (transactions.some((tx: any) => tx.ReferenceId === data.ReferenceId)) {
        const error: any = new Error('duplicate key value violates unique constraint');
        error.code = '23505';
        throw error;
      }

      const created = { id: transactions.length + 1, ...data };
      transactions.push(created);
      return created;
    });

    topupQuery.update.mockImplementation(async ({ data }: any) => {
      Object.assign(topup, data);
      return topup;
    });

    mockStrapi.db.transaction.mockImplementation((callback: any) => {
      const run = async () => {
        const trx: any = jest.fn((_table: string) => ({
          insert: jest.fn((row: any) => ({
            returning: jest.fn(() => ({
              onConflict: jest.fn(() => ({
                ignore: jest.fn().mockResolvedValue([
                  { id: 900, event_id: row.event_id },
                ]),
              })),
            })),
          })),
        }));
        trx.raw = jest.fn(async (sql: string, bindings: any[]) => {
            if (sql.includes('FROM wallet_topups')) {
              return {
                rows: [
                  {
                    id: topup.id,
                    amount: topup.Amount,
                    status: topup.Status,
                    sale_reference_id: topup.SaleReferenceId,
                    gateway: topup.Gateway ?? 'Mellat',
                  },
                ],
              };
            }

            // Credits resolve the wallet through the owner link under FOR UPDATE
            // so a customer's first ever credit cannot open two wallets.
            if (sql.includes('FROM local_user_wallets w')) {
              return {
                rows: [{ id: wallet.id, balance: wallet.Balance, held_balance: 0 }],
              };
            }

            if (sql.includes('UPDATE local_user_wallets')) {
              wallet.Balance += Number(bindings[0]);
              return { rows: [{ id: wallet.id, balance: wallet.Balance }] };
            }

            return { rows: [] };
          });

        return callback({ trx });
      };

      transactionQueue = transactionQueue.then(run, run);
      return transactionQueue;
    });

    return { transactions, walletQuery, topupQuery, transactionQuery };
  };

  beforeAll(async () => {
    // Dynamic imports
    walletModule = await import('../controllers/local-user-wallet');
    topupModule = await import('../../wallet-topup/controllers/wallet-topup');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const mock = createStrapiMock();
    mockStrapi = mock.strapi;

    // Make global strapi available
    (global as any).strapi = mockStrapi;

    // Recreate controllers with the mocked strapi instance
    walletController = walletModule.default({ strapi: mockStrapi });
    topupController = topupModule.default({ strapi: mockStrapi });

    // Mock Mellat service
    mellatService = {
      requestPayment: jest.fn(),
      verifyTransaction: jest.fn(),
      settleTransaction: jest.fn(),
    };
    mock.registerService('api::payment-gateway.mellat-v3', mellatService);

    // Mock queries
    const walletQuery = {
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    mock.registerQuery('api::local-user-wallet.local-user-wallet', walletQuery);

    mock.registerQuery('api::wallet-topup.wallet-topup', {
      findOne: jest.fn(),
      update: jest.fn(),
    });

    mock.registerQuery('api::local-user-wallet-transaction.local-user-wallet-transaction', {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    });

    // Mock config
    mockStrapi.config = {
      get: jest.fn((key, defaultValue) => defaultValue),
    };
  });

  describe('getCurrentUserWallet - Get wallet balance', () => {
    it('uses the shared content API auth strategy', () => {
      const route = walletRoutes.routes.find(
        (candidate: any) => candidate.path === '/local-user-wallet/me'
      );

      expect(route?.config.auth).toEqual({ scope: [] });
      expect(route?.config.middlewares).toBeUndefined();
    });

    it('should return wallet balance for authenticated user - REAL query', async () => {
      const userId = 1;
      const walletBalance = 500000; // 500k IRR

      const walletQuery = mockStrapi.db.query('api::local-user-wallet.local-user-wallet');
      walletQuery.findOne.mockResolvedValue({
        id: 10,
        Balance: walletBalance,
        LastTransactionDate: new Date(),
        Description: 'User wallet',
        user: userId,
      });

      const ctx = mockContext({
        state: { user: { id: userId } },
      });

      // ✅ Call REAL controller method
      await walletController.getCurrentUserWallet(ctx);

      expect(walletQuery.findOne).toHaveBeenCalledWith({
        where: { user: userId },
      });

      expect(ctx.send).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          balance: walletBalance,
        }),
      });
    });

    it('should reject a bearer header when no auth strategy populated state.user', async () => {
      const walletQuery = mockStrapi.db.query('api::local-user-wallet.local-user-wallet');
      const ctx = mockContext({
        request: { header: { authorization: 'Bearer unverified-token' } },
        state: {}, // No user in state
        unauthorized: jest.fn(),
      });

      await walletController.getCurrentUserWallet(ctx);

      expect(ctx.unauthorized).toHaveBeenCalledWith('Authentication required');
      expect(walletQuery.findOne).not.toHaveBeenCalled();
    });

    it('should return unauthorized without authentication', async () => {
      const ctx = mockContext({
        request: { header: {} },
        state: {},
        unauthorized: jest.fn(),
      });

      await walletController.getCurrentUserWallet(ctx);

      expect(ctx.unauthorized).toHaveBeenCalledWith('Authentication required');
    });

    it('should return a zero balance without creating a row if wallet does not exist', async () => {
      const walletQuery = mockStrapi.db.query('api::local-user-wallet.local-user-wallet');
      walletQuery.findOne.mockResolvedValue(null);

      const ctx = mockContext({
        state: { user: { id: 1 } },
      });

      await walletController.getCurrentUserWallet(ctx);

      expect(ctx.notFound).not.toHaveBeenCalled();
      expect(ctx.send).toHaveBeenCalledWith({
        success: true,
        data: {
          balance: 0,
        },
      });
      expect(ctx.send.mock.calls[0][0].data).not.toHaveProperty("id");
    });
  });

  describe('chargeIntent - Initiate wallet topup', () => {
    /**
     * Wires the durable intent `createWalletTopupIntent` would have written, and
     * models the per-customer advisory lock, the pending-cap count and the
     * idempotency lookup that all happen inside it.
     */
    const installIntentMocks = (
      options: {
        pendingCount?: number;
        existingByKey?: any;
        saleOrderTaken?: boolean;
      } = {},
    ) => {
      const created: any[] = [];
      const topupQuery = mockStrapi.db.query('api::wallet-topup.wallet-topup');
      topupQuery.create = jest.fn(async ({ data }: any) => {
        const row = { id: 100 + created.length, ...data };
        created.push(row);
        return row;
      });
      topupQuery.findOne = jest.fn(async ({ where }: any) => {
        if (where?.IdempotencyKey !== undefined) return options.existingByKey ?? null;
        return null;
      });

      mockStrapi.db.transaction.mockImplementation(async (callback: any) => {
        const trx: any = {
          raw: jest.fn(async (sql: string) => {
            if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
            if (/COUNT\(\*\)::int AS count/.test(sql)) {
              return { rows: [{ count: options.pendingCount ?? 0 }] };
            }
            if (/FROM wallet_topups WHERE sale_order_id/.test(sql)) {
              return { rows: options.saleOrderTaken ? [{ '?column?': 1 }] : [] };
            }
            return { rows: [] };
          }),
        };
        return callback({ trx });
      });

      // The state machine's guarded UPDATEs run on the pooled connection. Each
      // returns the affected row so the controller can tell "transitioned" from
      // "nothing matched" — a distinction it acts on.
      mockStrapi.db.connection.raw.mockImplementation(async (sql: string) => {
        if (/UPDATE wallet_topups/.test(sql)) return { rows: [{ id: 100 }] };
        return { rows: [] };
      });

      return { created, topupQuery };
    };

    /** `ctx.badRequest` in the shared mock throws, so a refusal is a rejection. */
    const expectRefusal = async (ctx: any, errorCode: string | RegExp) =>
      expect(topupController.chargeIntent(ctx)).rejects.toMatchObject({
        status: 400,
        payload: {
          data: expect.objectContaining({
            errorCode: typeof errorCode === 'string'
              ? errorCode
              : expect.stringMatching(errorCode),
          }),
        },
      });

    beforeEach(() => {
      process.env.WALLET_TOPUP_ENABLED = 'true';
      process.env.WALLET_TOPUP_GATEWAYS = 'mellat';
      process.env.MELLAT_TERMINAL_ID = 'terminal';
      process.env.MELLAT_USERNAME = 'username';
      process.env.MELLAT_PASSWORD = 'password';
      process.env.URL = 'https://api.example.test';
      setWalletTopupReadiness(true);
      mockStrapi.entityService.findMany.mockResolvedValue([
        { Title: 'بانک ملت', IsActive: true },
      ]);
    });

    afterEach(() => {
      delete process.env.WALLET_TOPUP_ENABLED;
      delete process.env.WALLET_TOPUP_GATEWAYS;
    });

    it('opens a durable intent, then asks the provider, then persists its handle', async () => {
      const { created } = installIntentMocks();
      mellatService.requestPayment.mockResolvedValue({
        success: true,
        refId: 'MELLAT-REF-123',
        redirectUrl: 'https://bpm.shaparak.ir/pgwchannel/startpay.mellat?RefId=MELLAT-REF-123',
      });

      const ctx = mockContext({
        request: { body: { amountToman: 100_000 } },
        state: { user: { id: 1 } },
      });

      await topupController.chargeIntent(ctx);

      // The intent exists, owner-bound and in IRR, before any provider call.
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        Amount: 1_000_000,
        Gateway: 'Mellat',
        Status: 'Pending',
        user: 1,
      });
      expect(String(created[0].SaleOrderId)).toMatch(/^\d+$/);

      // Top-ups return to their own endpoint, never the order callback.
      expect(mellatService.requestPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 1_000_000,
          amountInRial: true,
          callbackURL: 'https://api.example.test/api/wallet/payment-callback',
        }),
      );

      // The handle is durable before the customer is sent anywhere.
      const persisted = mockStrapi.db.connection.raw.mock.calls.filter(([sql]: [string]) =>
        /UPDATE wallet_topups[\s\S]*provider_reference/.test(sql),
      );
      expect(persisted).toHaveLength(1);

      expect(ctx.send).toHaveBeenCalledWith({
        data: expect.objectContaining({
          success: true,
          gateway: 'Mellat',
          refId: 'MELLAT-REF-123',
          redirectMethod: 'POST',
          redirectUrl: expect.stringContaining('bpm.shaparak.ir'),
        }),
      });
    });

    it('accepts Persian digits and rejects amounts outside the configured range', async () => {
      installIntentMocks();
      mellatService.requestPayment.mockResolvedValue({
        success: true,
        refId: 'REF',
        redirectUrl: 'https://example.test',
      });

      const persian = mockContext({
        request: { body: { amountToman: '۱۰۰٬۰۰۰' } },
        state: { user: { id: 1 } },
      });
      await topupController.chargeIntent(persian);
      expect(persian.badRequest).not.toHaveBeenCalled();

      for (const amountToman of [0, 9_999, 60_000_000]) {
        const ctx = mockContext({
          request: { body: { amountToman } },
          state: { user: { id: 1 } },
        });
        await expectRefusal(ctx, /WALLET_TOPUP_AMOUNT_(OUT_OF_RANGE|INVALID)/);
      }
    });

    it('rejects a malformed amount instead of coercing it', async () => {
      installIntentMocks();
      const ctx = mockContext({
        request: { body: { amountToman: '12a3' } },
        state: { user: { id: 1 } },
      });

      await expectRefusal(ctx, 'WALLET_TOPUP_AMOUNT_INVALID');
      expect(mellatService.requestPayment).not.toHaveBeenCalled();
    });

    it('refuses when the capability is switched off or its prerequisites are unmet', async () => {
      installIntentMocks();

      process.env.WALLET_TOPUP_ENABLED = 'false';
      const disabled = mockContext({
        request: { body: { amountToman: 100_000 } },
        state: { user: { id: 1 } },
      });
      await expectRefusal(disabled, 'WALLET_TOPUP_DISABLED');

      // The flag alone is not enough: the database prerequisites must verify.
      process.env.WALLET_TOPUP_ENABLED = 'true';
      setWalletTopupReadiness(false);
      const unready = mockContext({
        request: { body: { amountToman: 100_000 } },
        state: { user: { id: 1 } },
      });
      await expectRefusal(unready, 'WALLET_TOPUP_DISABLED');
      expect(mellatService.requestPayment).not.toHaveBeenCalled();
    });

    it('returns the original intent for a replayed idempotency key', async () => {
      installIntentMocks({
        existingByKey: {
          id: 500,
          SaleOrderId: '1700000000500',
          Gateway: 'Mellat',
          Amount: 1_000_000,
          RefId: 'MELLAT-REF-500',
        },
      });

      const ctx = mockContext({
        request: {
          body: { amountToman: 100_000, idempotencyKey: 'client-key-1' },
        },
        state: { user: { id: 1 } },
      });

      await topupController.chargeIntent(ctx);

      // No second provider session for a repeat of the same request.
      expect(mellatService.requestPayment).not.toHaveBeenCalled();
      expect(ctx.send).toHaveBeenCalledWith({
        data: expect.objectContaining({
          success: true,
          reused: true,
          saleOrderId: '1700000000500',
        }),
      });
    });

    it('refuses the same key with different parameters', async () => {
      installIntentMocks({
        existingByKey: {
          id: 500,
          SaleOrderId: '1700000000500',
          Gateway: 'Mellat',
          Amount: 2_000_000,
        },
      });

      const ctx = mockContext({
        request: {
          body: { amountToman: 100_000, idempotencyKey: 'client-key-1' },
        },
        state: { user: { id: 1 } },
      });

      await expectRefusal(ctx, 'WALLET_TOPUP_IDEMPOTENCY_CONFLICT');
      expect(mellatService.requestPayment).not.toHaveBeenCalled();
    });

    it('enforces the pending cap inside the same lock that inserts', async () => {
      installIntentMocks({ pendingCount: 3 });

      const ctx = mockContext({
        request: { body: { amountToman: 100_000 } },
        state: { user: { id: 1 } },
      });

      await expectRefusal(ctx, 'WALLET_TOPUP_PENDING_LIMIT');
      expect(mellatService.requestPayment).not.toHaveBeenCalled();
    });

    it('closes the intent when the provider answers with a refusal', async () => {
      installIntentMocks();
      mellatService.requestPayment.mockResolvedValue({
        success: false,
        resCode: 34,
        error: 'Gateway error: 34',
      });

      const ctx = mockContext({
        request: { body: { amountToman: 100_000 } },
        state: { user: { id: 1 } },
      });

      await expectRefusal(ctx, 'MELLAT_34');
      const failed = mockStrapi.db.connection.raw.mock.calls.filter(([sql]: [string]) =>
        /UPDATE wallet_topups[\s\S]*status = 'Failed'/.test(sql),
      );
      expect(failed).toHaveLength(1);
    });

    it('keeps the intent open when the provider never answered', async () => {
      installIntentMocks();
      // A transport failure carries no bank verdict: a session may exist.
      mellatService.requestPayment.mockResolvedValue({
        success: false,
        error: 'socket hang up',
        errorCode: 'ECONNRESET',
      });

      const ctx = mockContext({
        request: { body: { amountToman: 100_000 } },
        state: { user: { id: 1 } },
      });

      const response: any = await topupController.chargeIntent(ctx);

      expect(ctx.status).toBe(202);
      expect(response.data).toMatchObject({ errorCode: 'WALLET_TOPUP_UNKNOWN' });
      const failed = mockStrapi.db.connection.raw.mock.calls.filter(([sql]: [string]) =>
        /UPDATE wallet_topups[\s\S]*status = 'Failed'/.test(sql),
      );
      expect(failed).toHaveLength(0);
      const unknown = mockStrapi.db.connection.raw.mock.calls.filter(([sql]: [string]) =>
        /UPDATE wallet_topups[\s\S]*status = 'Unknown'/.test(sql),
      );
      expect(unknown).toHaveLength(1);
    });

    it('should require authentication', async () => {
      installIntentMocks();
      const ctx = mockContext({
        request: { body: { amountToman: 100_000 } },
        state: {},
      });

      await topupController.chargeIntent(ctx);

      expect(ctx.unauthorized).toHaveBeenCalled();
      expect(mellatService.requestPayment).not.toHaveBeenCalled();
    });
  });

  /**
   * Callback correlation and state monotonicity live in
   * `api/wallet-topup/__tests__/wallet-topup-callback-correlation.spec.ts`,
   * which models the guarded state machine rather than stubbing it. What is
   * kept here is the credit path itself.
   */
  describe('paymentCallback - Process payment callback', () => {





    it('should verify and settle payment on success - REAL payment flow', async () => {
      const saleOrderId = '1234567890123';
      const saleReferenceId = '987654321';

      mockStrapi.entityService.findMany.mockResolvedValue([
        {
          id: 100,
          SaleOrderId: saleOrderId,
          Amount: 1000000,
          Status: 'Pending',
          user: { id: 1 },
        },
      ]);

      // Mock successful verification
      mellatService.verifyTransaction.mockResolvedValue({
        success: true,
      });

      // Mock successful settlement
      mellatService.settleTransaction.mockResolvedValue({
        success: true,
      });

      installTopupTransactionMocks({
        topup: {
          id: 100,
          SaleOrderId: saleOrderId,
          Amount: 1000000,
          Status: 'Pending',
          user: { id: 1 },
        },
        wallet: {
          id: 10,
          Balance: 500000,
          user: 1,
        },
      });

      const ctx = mockContext({
        request: {
          body: {
            ResCode: '0', // Success
            SaleOrderId: saleOrderId,
            SaleReferenceId: saleReferenceId,
          },
        },
      });

      await topupController.paymentCallback(ctx);

      // ✅ Should verify payment
      expect(mellatService.verifyTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: saleOrderId,
          saleOrderId: saleOrderId,
          saleReferenceId: saleReferenceId,
        })
      );

      // ✅ Should settle payment
      expect(mellatService.settleTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: saleOrderId,
        })
      );
      expect(mellatService.settleTransaction.mock.calls[0][0]).toEqual(
        expect.objectContaining({ allowResCode45Success: true })
      );
    });

    it('should credit wallet only once when the same callback is replayed', async () => {
      const saleOrderId = '1234567890123';
      const saleReferenceId = 'REPLAY-REF-1';
      const topup = {
        id: 101,
        SaleOrderId: saleOrderId,
        Amount: 1000000,
        Status: 'Pending',
        user: { id: 1 },
      };
      const wallet = { id: 10, Balance: 500000, user: 1 };
      const { transactionQuery, topupQuery } = installTopupTransactionMocks({
        topup,
        wallet,
      });

      mockStrapi.entityService.findMany.mockResolvedValue([topup]);
      mellatService.verifyTransaction.mockResolvedValue({ success: true });
      mellatService.settleTransaction.mockResolvedValue({ success: true });

      const callbackBody = {
        ResCode: '0',
        SaleOrderId: saleOrderId,
        SaleReferenceId: saleReferenceId,
      };
      const ctx1 = mockContext({ request: { body: callbackBody } });
      const ctx2 = mockContext({ request: { body: callbackBody } });

      await topupController.paymentCallback(ctx1);
      await topupController.paymentCallback(ctx2);

      expect(wallet.Balance).toBe(1500000);
      expect(transactionQuery.create).toHaveBeenCalledTimes(1);
      expect(topupQuery.update).toHaveBeenCalledTimes(1);
      expect(mellatService.verifyTransaction).toHaveBeenCalledTimes(1);
      expect(mellatService.settleTransaction).toHaveBeenCalledTimes(1);
      expect(ctx1.redirect).toHaveBeenCalledWith(expect.stringContaining('status=success'));
      expect(ctx2.redirect).toHaveBeenCalledWith(expect.stringContaining('status=success'));
    });

    it('should credit wallet only once for concurrent callbacks', async () => {
      const saleOrderId = '1234567890124';
      const saleReferenceId = 'CONCURRENT-REF-1';
      const topup = {
        id: 102,
        SaleOrderId: saleOrderId,
        Amount: 1000000,
        Status: 'Pending',
        user: { id: 1 },
      };
      const wallet = { id: 10, Balance: 500000, user: 1 };
      const { transactionQuery, topupQuery } = installTopupTransactionMocks({
        topup,
        wallet,
      });

      mockStrapi.entityService.findMany.mockResolvedValue([topup]);
      mellatService.verifyTransaction.mockResolvedValue({ success: true });
      mellatService.settleTransaction.mockResolvedValue({ success: true });

      const callbackBody = {
        ResCode: '0',
        SaleOrderId: saleOrderId,
        SaleReferenceId: saleReferenceId,
      };
      const ctx1 = mockContext({ request: { body: callbackBody } });
      const ctx2 = mockContext({ request: { body: callbackBody } });

      await Promise.all([
        topupController.paymentCallback(ctx1),
        topupController.paymentCallback(ctx2),
      ]);

      expect(wallet.Balance).toBe(1500000);
      expect(transactionQuery.create).toHaveBeenCalledTimes(1);
      expect(topupQuery.update).toHaveBeenCalledTimes(1);
      expect(mellatService.verifyTransaction).toHaveBeenCalledTimes(1);
      expect(mellatService.settleTransaction).toHaveBeenCalledTimes(1);
      expect(ctx1.redirect).toHaveBeenCalledWith(expect.stringContaining('status=success'));
      expect(ctx2.redirect).toHaveBeenCalledWith(
        expect.stringMatching(/status=(success|pending)/)
      );
    });

    it('should short-circuit existing wallet transaction before gateway calls', async () => {
      const saleOrderId = '1234567890125';
      const saleReferenceId = 'EXISTING-REF-1';
      const topup = {
        id: 103,
        SaleOrderId: saleOrderId,
        Gateway: 'Mellat',
        RefId: 'MELLAT-REF-103',
        ProviderReference: 'MELLAT-REF-103',
        Amount: 1000000,
        Status: 'Pending',
        user: { id: 1 },
      };
      const { transactionQuery } = installTopupTransactionMocks({
        topup,
        wallet: { id: 10, Balance: 500000, user: 1 },
        // Keyed the way a credit is written now: scoped by gateway.
        existingTransactions: [
          { id: 99, ReferenceId: `wallet-topup-Mellat-${saleReferenceId}` },
        ],
      });

      const ctx = mockContext({
        request: {
          body: {
            ResCode: '0',
            SaleOrderId: saleOrderId,
            SaleReferenceId: saleReferenceId,
            RefId: 'MELLAT-REF-103',
          },
        },
      });

      await topupController.paymentCallback(ctx);

      expect(mockStrapi.db.transaction).not.toHaveBeenCalled();
      expect(transactionQuery.create).not.toHaveBeenCalled();
      expect(mellatService.verifyTransaction).not.toHaveBeenCalled();
      expect(mellatService.settleTransaction).not.toHaveBeenCalled();
      expect(ctx.redirect).toHaveBeenCalledWith(expect.stringContaining('status=success'));
    });
  });

  describe('Money units and bounds', () => {
    /** Same harness as the chargeIntent block; repeated here for locality. */
    const installIntentMocks = () => {
      const created: any[] = [];
      const topupQuery = mockStrapi.db.query('api::wallet-topup.wallet-topup');
      topupQuery.create = jest.fn(async ({ data }: any) => {
        const row = { id: 100 + created.length, ...data };
        created.push(row);
        return row;
      });
      topupQuery.findOne = jest.fn(async () => null);
      mockStrapi.db.transaction.mockImplementation(async (callback: any) =>
        callback({
          trx: {
            raw: jest.fn(async (sql: string) => {
              if (/COUNT\(\*\)::int AS count/.test(sql)) return { rows: [{ count: 0 }] };
              return { rows: [] };
            }),
          },
        }),
      );
      mockStrapi.db.connection.raw.mockImplementation(async (sql: string) =>
        /UPDATE wallet_topups/.test(sql) ? { rows: [{ id: 100 }] } : { rows: [] },
      );
      return created;
    };

    beforeEach(() => {
      process.env.WALLET_TOPUP_ENABLED = 'true';
      process.env.WALLET_TOPUP_GATEWAYS = 'mellat';
      process.env.MELLAT_TERMINAL_ID = 'terminal';
      process.env.MELLAT_USERNAME = 'username';
      process.env.MELLAT_PASSWORD = 'password';
      process.env.URL = 'https://api.example.test';
      setWalletTopupReadiness(true);
      mockStrapi.entityService.findMany.mockResolvedValue([
        { Title: 'بانک ملت', IsActive: true },
      ]);
      mellatService.requestPayment.mockResolvedValue({
        success: true,
        refId: 'REF-123',
        redirectUrl: 'https://example.test',
      });
    });

    afterEach(() => {
      delete process.env.WALLET_TOPUP_ENABLED;
      delete process.env.WALLET_TOPUP_GATEWAYS;
    });

    it('converts the customer-facing toman amount to IRR exactly once', async () => {
      const created = installIntentMocks();

      const ctx = mockContext({
        request: { body: { amountToman: 1_000_000 } },
        state: { user: { id: 1 } },
      });
      await topupController.chargeIntent(ctx);

      // Stored and charged in IRR; the toman figure never reaches the provider.
      expect(created[0].Amount).toBe(10_000_000);
      expect(mellatService.requestPayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 10_000_000, amountInRial: true }),
      );
    });

    it('still accepts a legacy IRR amount, with the same bounds applied', async () => {
      const created = installIntentMocks();

      const ctx = mockContext({
        request: { body: { amount: 10_000_000 } },
        state: { user: { id: 1 } },
      });
      await topupController.chargeIntent(ctx);

      expect(created[0].Amount).toBe(10_000_000);
    });

    it('refuses an amount beyond the configured ceiling', async () => {
      installIntentMocks();

      const ctx = mockContext({
        request: { body: { amount: 1_000_000_000 } },
        state: { user: { id: 1 } },
      });

      await expect(topupController.chargeIntent(ctx)).rejects.toMatchObject({
        status: 400,
        payload: {
          data: expect.objectContaining({ errorCode: 'WALLET_TOPUP_AMOUNT_OUT_OF_RANGE' }),
        },
      });
      expect(mellatService.requestPayment).not.toHaveBeenCalled();
    });

    it('gives two simultaneous requests two distinct references', async () => {
      const created = installIntentMocks();

      await Promise.all([
        topupController.chargeIntent(
          mockContext({
            request: { body: { amountToman: 50_000 } },
            state: { user: { id: 1 } },
          }),
        ),
        topupController.chargeIntent(
          mockContext({
            request: { body: { amountToman: 50_000 } },
            state: { user: { id: 1 } },
          }),
        ),
      ]);

      expect(created).toHaveLength(2);
      expect(created[0].SaleOrderId).not.toBe(created[1].SaleOrderId);
    });
  });
});
