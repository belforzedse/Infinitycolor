/**
 * Admin wallet adjustment tests (adminAdjustWallet / adminGetUserWallet).
 * Validates Toman→Rial conversion, credit/debit/set routing, validation,
 * insufficient-funds handling, ledger writes, and audit logging.
 */

// Simplify Strapi controller/service factories for tests.
jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, extension: any) => (params: any) => extension(params),
    createCoreService: () => ({}),
  },
}));

// Mock the atomic wallet service so we can assert how the controller drives it.
const creditWalletBalanceAtomic = jest.fn();
const deductWalletBalanceAtomic = jest.fn();
jest.mock("../services/local-user-wallet", () => ({
  __esModule: true,
  creditWalletBalanceAtomic: (...args: any[]) => creditWalletBalanceAtomic(...args),
  deductWalletBalanceAtomic: (...args: any[]) => deductWalletBalanceAtomic(...args),
  default: {},
}));

// Mock the audit writer (fire-and-forget; we only assert it was called).
const recordAdminAudit = jest.fn().mockResolvedValue(true);
jest.mock("../../../utils/adminAudit", () => ({
  __esModule: true,
  recordAdminAudit: (...args: any[]) => recordAdminAudit(...args),
}));

import { createStrapiMock } from "../../../__tests__/helpers/test-utils";

const WALLET_UID = "api::local-user-wallet.local-user-wallet";
const USER_UID = "plugin::users-permissions.user";
const TX_UID = "api::local-user-wallet-transaction.local-user-wallet-transaction";

const makeCtx = (body: any) => {
  const ctx: any = {
    params: {},
    request: { body, header: {} },
    state: { user: { id: 99, role: { name: "Superadmin" } } },
    badRequest: jest.fn((message: string, payload?: unknown) => ({ status: 400, message, payload })),
    notFound: jest.fn((message: string, payload?: unknown) => ({ status: 404, message, payload })),
    internalServerError: jest.fn((message: string) => ({ status: 500, message })),
    send: jest.fn((data: any) => data),
  };
  return ctx;
};

describe("adminAdjustWallet", () => {
  let controller: any;
  let mockStrapi: any;
  let mock: ReturnType<typeof createStrapiMock>;

  const setupQueries = (fromIrr: number, userExists = true) => {
    mock.registerQuery(USER_UID, {
      findOne: jest.fn().mockResolvedValue(userExists ? { id: 1 } : null),
    });
    mock.registerQuery(WALLET_UID, {
      findOne: jest.fn().mockResolvedValue({ id: 10, Balance: fromIrr }),
    });
    mock.registerQuery(TX_UID, {
      create: jest.fn().mockResolvedValue({ id: 1 }),
    });
  };

  beforeAll(async () => {
    const mod = await import("../controllers/local-user-wallet");
    controller = mod.default;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mock = createStrapiMock();
    mockStrapi = mock.strapi;
  });

  const build = () => controller({ strapi: mockStrapi });

  it("credits the wallet, converts Toman→Rial, writes an Add ledger row and audit", async () => {
    setupQueries(100_000); // 10,000 Toman current
    creditWalletBalanceAtomic.mockResolvedValue({ success: true, newBalance: 150_000, walletId: 10 });
    const c = build();
    const ctx = makeCtx({ userId: 1, mode: "credit", amountToman: 5_000, reason: "refund" });

    await c.adminAdjustWallet(ctx);

    // 5,000 Toman → 50,000 IRR credited
    expect(creditWalletBalanceAtomic).toHaveBeenCalledWith(mockStrapi, 1, 50_000);
    const txCreate = mockStrapi.db.query(TX_UID).create as jest.Mock;
    expect(txCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ Amount: 50_000, Type: "Add", Note: "refund", user_wallet: 10 }),
      }),
    );
    expect(recordAdminAudit).toHaveBeenCalledWith(
      mockStrapi,
      expect.objectContaining({ action: "Adjust", resourceType: "User", resourceId: 1 }),
    );
    expect(ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: expect.objectContaining({ balanceToman: 15_000 }) }),
    );
  });

  it("debits the wallet (Minus ledger row)", async () => {
    setupQueries(100_000);
    deductWalletBalanceAtomic.mockResolvedValue({ success: true, newBalance: 50_000, walletId: 10 });
    const c = build();
    const ctx = makeCtx({ userId: 1, mode: "debit", amountToman: 5_000, reason: "correction" });

    await c.adminAdjustWallet(ctx);

    expect(deductWalletBalanceAtomic).toHaveBeenCalledWith(mockStrapi, 1, 50_000);
    expect((mockStrapi.db.query(TX_UID).create as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ Type: "Minus", Amount: 50_000 }) }),
    );
  });

  it("set mode computes the delta vs current balance and routes to debit when lower", async () => {
    setupQueries(100_000); // 10,000 Toman
    deductWalletBalanceAtomic.mockResolvedValue({ success: true, newBalance: 60_000, walletId: 10 });
    const c = build();
    const ctx = makeCtx({ userId: 1, mode: "set", amountToman: 6_000, reason: "set lower" });

    await c.adminAdjustWallet(ctx);

    // target 6,000 Toman = 60,000 IRR; current 100,000 IRR → debit 40,000 IRR
    expect(deductWalletBalanceAtomic).toHaveBeenCalledWith(mockStrapi, 1, 40_000);
    expect(creditWalletBalanceAtomic).not.toHaveBeenCalled();
  });

  it("rejects debit when balance is insufficient", async () => {
    setupQueries(10_000);
    deductWalletBalanceAtomic.mockResolvedValue({ success: false, error: "Insufficient balance: ..." });
    const c = build();
    const ctx = makeCtx({ userId: 1, mode: "debit", amountToman: 5_000, reason: "too much" });

    await c.adminAdjustWallet(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith(
      "موجودی کیف پول کافی نیست",
      expect.objectContaining({ data: expect.objectContaining({ errorCode: "INSUFFICIENT_BALANCE" }) }),
    );
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    setupQueries(100_000);
    const c = build();
    const ctx = makeCtx({ userId: 1, mode: "credit", amountToman: 5_000, reason: "   " });

    await c.adminAdjustWallet(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith(
      expect.stringContaining("دلیل"),
      expect.objectContaining({ data: expect.objectContaining({ errorCode: "REASON_REQUIRED" }) }),
    );
    expect(creditWalletBalanceAtomic).not.toHaveBeenCalled();
  });

  it("rejects a non-positive / non-integer amount", async () => {
    setupQueries(100_000);
    const c = build();
    const ctx = makeCtx({ userId: 1, mode: "credit", amountToman: 0, reason: "x" });

    await c.adminAdjustWallet(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ data: expect.objectContaining({ errorCode: "INVALID_AMOUNT" }) }),
    );
  });

  it("returns 404 when the target user does not exist", async () => {
    setupQueries(100_000, false);
    const c = build();
    const ctx = makeCtx({ userId: 1234, mode: "credit", amountToman: 5_000, reason: "x" });

    await c.adminAdjustWallet(ctx);

    expect(ctx.notFound).toHaveBeenCalled();
    expect(creditWalletBalanceAtomic).not.toHaveBeenCalled();
  });
});
