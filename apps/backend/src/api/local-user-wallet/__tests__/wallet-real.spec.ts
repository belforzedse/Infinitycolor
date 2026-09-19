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

    topupQuery.findOne.mockImplementation(async () => topup);

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

    transactionQuery.findOne.mockImplementation(async ({ where }: any) =>
      transactions.find((tx: any) => tx.ReferenceId === where.ReferenceId) || null
    );

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
    it('should create topup and request payment - REAL flow', async () => {
      const userId = 1;
      const amountIrr = 1000000; // 1M IRR = 100k Toman

      // Mock topup creation
      const topup = {
        id: 100,
        Amount: amountIrr,
        Status: 'Pending',
        user: userId,
      };
      mockStrapi.entityService.create.mockResolvedValue(topup);

      // Mock payment gateway success
      mellatService.requestPayment.mockResolvedValue({
        success: true,
        refId: 'MELLAT-REF-123',
        redirectUrl: 'https://bpm.shaparak.ir/pgwchannel/startpay.mellat?RefId=MELLAT-REF-123',
      });

      const ctx = mockContext({
        request: { body: { amount: amountIrr } },
        state: { user: { id: userId } },
      });

      // ✅ Call REAL controller method
      await topupController.chargeIntent(ctx);

      // ✅ Verify REAL topup creation
      expect(mockStrapi.entityService.create).toHaveBeenCalledWith(
        'api::wallet-topup.wallet-topup',
        expect.objectContaining({
          data: expect.objectContaining({
            Amount: amountIrr,
            Status: 'Pending',
            user: userId,
          }),
        })
      );

      // ✅ Verify REAL payment request
      expect(mellatService.requestPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: amountIrr,
          userId,
          callbackURL: expect.stringContaining('/api/wallet/payment-callback'),
        })
      );

      // ✅ Verify REAL response
      expect(ctx.send).toHaveBeenCalledWith({
        data: expect.objectContaining({
          success: true,
          refId: 'MELLAT-REF-123',
          redirectUrl: expect.stringContaining('bpm.shaparak.ir'),
        }),
      });
    });

    it('should reject zero or negative amounts - REAL validation', async () => {
      const ctx = mockContext({
        request: { body: { amount: 0 } },
        state: { user: { id: 1 } },
        badRequest: jest.fn(),
      });

      await topupController.chargeIntent(ctx);

      expect(ctx.badRequest).toHaveBeenCalledWith('amount is required (IRR)');
      expect(mockStrapi.entityService.create).not.toHaveBeenCalled();
    });

    it('should reject invalid amounts', async () => {
      const ctx = mockContext({
        request: { body: { amount: 'invalid' } },
        state: { user: { id: 1 } },
        badRequest: jest.fn(),
      });

      await topupController.chargeIntent(ctx);

      expect(ctx.badRequest).toHaveBeenCalledWith('amount is required (IRR)');
    });

    it('should handle payment gateway failures - REAL error handling', async () => {
      const userId = 1;
      const amountIrr = 1000000;

      mockStrapi.entityService.create.mockResolvedValue({
        id: 100,
        Amount: amountIrr,
      });

      mellatService.requestPayment.mockResolvedValue({
        success: false,
        error: 'Gateway timeout',
      });

      const ctx = mockContext({
        request: { body: { amount: amountIrr } },
        state: { user: { id: userId } },
        badRequest: jest.fn(),
      });

      await topupController.chargeIntent(ctx);

      // ✅ Should mark topup as Failed
      expect(mockStrapi.entityService.update).toHaveBeenCalledWith(
        'api::wallet-topup.wallet-topup',
        100,
        expect.objectContaining({
          data: { Status: 'Failed' },
        })
      );

      expect(ctx.badRequest).toHaveBeenCalledWith('Gateway error', expect.anything());
    });

    it('should require authentication', async () => {
      const ctx = mockContext({
        request: { body: { amount: 1000000 } },
        state: {},
        unauthorized: jest.fn(),
        badRequest: jest.fn(),
      });

      await topupController.chargeIntent(ctx);

      expect(ctx.unauthorized).toHaveBeenCalledWith('Authentication required');
    });

    it('should generate unique SaleOrderId - REAL ID generation', async () => {
      mockStrapi.entityService.create.mockResolvedValue({ id: 1 });
      mellatService.requestPayment.mockResolvedValue({
        success: true,
        refId: 'REF-123',
        redirectUrl: 'https://example.com',
      });

      const ctx = mockContext({
        request: { body: { amount: 500000 } },
        state: { user: { id: 1 } },
      });

      await topupController.chargeIntent(ctx);

      // Verify SaleOrderId is unique (timestamp + random)
      const createCall = mockStrapi.entityService.create.mock.calls[0][1];
      const saleOrderId = createCall.data.SaleOrderId;

      expect(saleOrderId).toMatch(/^\d{13,16}$/); // Timestamp + 3-digit suffix
    });

    it('should save RefId after successful payment request', async () => {
      const topupId = 100;
      const refId = 'MELLAT-REF-456';

      mockStrapi.entityService.create.mockResolvedValue({ id: topupId });
      mellatService.requestPayment.mockResolvedValue({
        success: true,
        refId,
        redirectUrl: 'https://example.com',
      });

      const ctx = mockContext({
        request: { body: { amount: 500000 } },
        state: { user: { id: 1 } },
      });

      await topupController.chargeIntent(ctx);

      // ✅ Should save RefId for tracking
      expect(mockStrapi.entityService.update).toHaveBeenCalledWith(
        'api::wallet-topup.wallet-topup',
        topupId,
        expect.objectContaining({
          data: { RefId: refId },
        })
      );
    });
  });

  describe('paymentCallback - Process payment callback', () => {
    it('should mark topup as Failed on user cancellation - REAL flow', async () => {
      const saleOrderId = '1234567890123';
      const resCode = '17'; // User cancelled

      mockStrapi.entityService.findMany.mockResolvedValue([
        {
          id: 100,
          SaleOrderId: saleOrderId,
          RefId: 'MELLAT-REF-100',
          Amount: 1000000,
          Status: 'Pending',
        },
      ]);

      const ctx = mockContext({
        request: {
          body: {
            ResCode: resCode,
            SaleOrderId: saleOrderId,
            SaleReferenceId: '123456',
            // RefId is what ties this callback to that specific attempt.
            RefId: 'MELLAT-REF-100',
          },
        },
      });

      // ✅ Call REAL controller method
      await topupController.paymentCallback(ctx);

      // ✅ Transitions via the guarded CAS, so it can only move Pending -> Failed
      const failureUpdates = mockStrapi.db.connection.raw.mock.calls.filter(
        ([sql]: [string]) => /UPDATE wallet_topups/.test(sql) && /status = 'Failed'/.test(sql)
      );
      expect(failureUpdates).toHaveLength(1);
      expect(failureUpdates[0][0]).toMatch(/AND\s+status IN \(\?\)/);
      expect(failureUpdates[0][1]).toEqual([
        17,
        'Mellat callback failure 17',
        100,
        'Pending',
      ]);

      // ✅ Should redirect to frontend with failure status
      expect(ctx.redirect).toHaveBeenCalledWith(
        expect.stringContaining('wallet?status=failure&code=17')
      );
    });

    it('should refuse a failure callback whose RefId belongs to a different attempt', async () => {
      const saleOrderId = '1234567890123';

      mockStrapi.entityService.findMany.mockResolvedValue([
        {
          id: 100,
          SaleOrderId: saleOrderId,
          RefId: 'MELLAT-REF-100',
          Amount: 1000000,
          Status: 'Success',
        },
      ]);

      const ctx = mockContext({
        request: {
          body: {
            ResCode: '17',
            SaleOrderId: saleOrderId,
            SaleReferenceId: '123456',
            // Another attempt's provider reference pointed at this local row.
            RefId: 'MELLAT-REF-999',
          },
        },
      });

      await topupController.paymentCallback(ctx);

      expect(
        mockStrapi.db.connection.raw.mock.calls.filter(([sql]: [string]) =>
          /UPDATE wallet_topups/.test(sql)
        )
      ).toHaveLength(0);
      expect(mockStrapi.entityService.update).not.toHaveBeenCalled();
      expect(ctx.redirect).toHaveBeenCalledWith(
        expect.stringContaining('wallet?status=failure&reason=unverified')
      );
    });

    it('should refuse a failure callback when the attempt has no persisted RefId', async () => {
      const saleOrderId = '1234567890123';

      mockStrapi.entityService.findMany.mockResolvedValue([
        { id: 100, SaleOrderId: saleOrderId, Amount: 1000000, Status: 'Pending' },
      ]);

      const ctx = mockContext({
        request: {
          body: { ResCode: '17', SaleOrderId: saleOrderId, SaleReferenceId: '123456' },
        },
      });

      await topupController.paymentCallback(ctx);

      // Unverifiable, so the attempt is left Pending for reconciliation rather than
      // being destroyed on the strength of a caller-supplied SaleOrderId alone.
      expect(
        mockStrapi.db.connection.raw.mock.calls.filter(([sql]: [string]) =>
          /UPDATE wallet_topups/.test(sql)
        )
      ).toHaveLength(0);
      expect(mockStrapi.entityService.update).not.toHaveBeenCalled();
      expect(ctx.redirect).toHaveBeenCalledWith(
        expect.stringContaining('wallet?status=failure&reason=unverified')
      );
    });

    it('should refuse a success callback whose RefId does not match the attempt', async () => {
      const saleOrderId = '1234567890123';

      mockStrapi.entityService.findMany.mockResolvedValue([
        {
          id: 100,
          SaleOrderId: saleOrderId,
          RefId: 'MELLAT-REF-100',
          Amount: 1000000,
          Status: 'Pending',
          user: { id: 99 },
        },
      ]);

      const ctx = mockContext({
        request: {
          body: {
            ResCode: '0',
            SaleOrderId: saleOrderId,
            SaleReferenceId: 'REF-SUCCESS-123',
            RefId: 'MELLAT-REF-999',
          },
        },
      });

      await topupController.paymentCallback(ctx);

      expect(mellatService.verifyTransaction).not.toHaveBeenCalled();
      expect(mellatService.settleTransaction).not.toHaveBeenCalled();
      expect(ctx.redirect).toHaveBeenCalledWith(
        expect.stringContaining('wallet?status=failure&reason=unverified')
      );
    });

    it('should redirect to not_found if topup does not exist', async () => {
      mockStrapi.entityService.findMany.mockResolvedValue([]);

      const ctx = mockContext({
        request: {
          body: {
            ResCode: '0',
            SaleOrderId: '999999999',
            SaleReferenceId: '123456',
          },
        },
      });

      await topupController.paymentCallback(ctx);

      expect(ctx.redirect).toHaveBeenCalledWith(
        expect.stringContaining('wallet?status=failure&reason=not_found')
      );
    });

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
        Amount: 1000000,
        Status: 'Pending',
        user: { id: 1 },
      };
      const { transactionQuery } = installTopupTransactionMocks({
        topup,
        wallet: { id: 10, Balance: 500000, user: 1 },
        existingTransactions: [{ id: 99, ReferenceId: saleReferenceId }],
      });

      mockStrapi.entityService.findMany.mockResolvedValue([topup]);

      const ctx = mockContext({
        request: {
          body: {
            ResCode: '0',
            SaleOrderId: saleOrderId,
            SaleReferenceId: saleReferenceId,
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

  describe('Financial calculations', () => {
    it('should handle IRR amounts correctly - 1M IRR = 100k Toman', async () => {
      const amountIrr = 10000000; // 10M IRR
      const expectedToman = 1000000; // 1M Toman

      mockStrapi.entityService.create.mockResolvedValue({ id: 1 });
      mellatService.requestPayment.mockResolvedValue({
        success: true,
        refId: 'REF-123',
        redirectUrl: 'https://example.com',
      });

      const ctx = mockContext({
        request: { body: { amount: amountIrr } },
        state: { user: { id: 1 } },
      });

      await topupController.chargeIntent(ctx);

      // ✅ Verify amount is stored in IRR (not Toman)
      const createCall = mockStrapi.entityService.create.mock.calls[0][1];
      expect(createCall.data.Amount).toBe(amountIrr);

      // ✅ Verify payment gateway receives IRR amount
      expect(mellatService.requestPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: amountIrr,
        })
      );
    });
  });

  describe('Edge cases', () => {
    it('should handle concurrent topup requests', async () => {
      const userId = 1;
      const amount = 500000;

      mockStrapi.entityService.create.mockResolvedValue({ id: 100 });
      mellatService.requestPayment.mockResolvedValue({
        success: true,
        refId: 'REF-1',
        redirectUrl: 'https://example.com',
      });

      const ctx1 = mockContext({
        request: { body: { amount } },
        state: { user: { id: userId } },
      });

      const ctx2 = mockContext({
        request: { body: { amount } },
        state: { user: { id: userId } },
      });

      // Make concurrent requests
      await Promise.all([
        topupController.chargeIntent(ctx1),
        topupController.chargeIntent(ctx2),
      ]);

      // ✅ Both should create separate topups with unique SaleOrderIds
      expect(mockStrapi.entityService.create).toHaveBeenCalledTimes(2);

      const saleOrderId1 = mockStrapi.entityService.create.mock.calls[0][1].data.SaleOrderId;
      const saleOrderId2 = mockStrapi.entityService.create.mock.calls[1][1].data.SaleOrderId;

      expect(saleOrderId1).not.toBe(saleOrderId2);
    });

    it('should handle very large amounts', async () => {
      const largeAmount = 1000000000; // 1B IRR = 100M Toman

      mockStrapi.entityService.create.mockResolvedValue({ id: 1 });
      mellatService.requestPayment.mockResolvedValue({
        success: true,
        refId: 'REF-123',
        redirectUrl: 'https://example.com',
      });

      const ctx = mockContext({
        request: { body: { amount: largeAmount } },
        state: { user: { id: 1 } },
      });

      await topupController.chargeIntent(ctx);

      expect(mockStrapi.entityService.create).toHaveBeenCalledWith(
        'api::wallet-topup.wallet-topup',
        expect.objectContaining({
          data: expect.objectContaining({
            Amount: largeAmount,
          }),
        })
      );
    });
  });
});
