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

// Mock the transactional application service so controller tests stay at the API boundary.
const applyAdminWalletAdjustment = jest.fn();
jest.mock("../services/local-user-wallet", () => ({
  __esModule: true,
  WalletAdjustmentError: class WalletAdjustmentError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
  applyAdminWalletAdjustment: (...args: any[]) => applyAdminWalletAdjustment(...args),
  default: {},
}));

// Mock the canonical audit writer; denied attempts and committed mutations use it directly.
const writeAuditEvent = jest.fn().mockResolvedValue({
  id: 1,
  eventId: "e4ff6887-7058-41f7-bba4-fbc47c3572be",
  deduplicated: false,
});
jest.mock("../../../audit/writer", () => ({
  __esModule: true,
  writeAuditEvent: (...args: any[]) => writeAuditEvent(...args),
}));

import { createStrapiMock } from "../../../__tests__/helpers/test-utils";
import { WalletAdjustmentError } from "../services/local-user-wallet";

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
    forbidden: jest.fn((message: string, payload?: unknown) => ({ status: 403, message, payload })),
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
    applyAdminWalletAdjustment.mockResolvedValue({
      walletId: 10,
      beforeBalance: 100_000,
      afterBalance: 150_000,
      delta: 50_000,
      changed: true,
      ledgerId: 1,
      transactionType: "Add",
    });
    const c = build();
    const ctx = makeCtx({ userId: 1, mode: "credit", amountToman: 5_000, reason: "refund" });

    await c.adminAdjustWallet(ctx);

    // 5,000 Toman → 50,000 IRR credited
    expect(applyAdminWalletAdjustment).toHaveBeenCalledWith(
      mockStrapi,
      expect.objectContaining({
        userId: 1,
        mode: "credit",
        amountIrr: 50_000,
        reason: "refund",
        audit: expect.objectContaining({
          origin: "admin_ui",
          initiator: expect.objectContaining({ type: "human", id: 99 }),
        }),
      }),
    );
    expect(ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: expect.objectContaining({ balanceToman: 15_000 }) }),
    );
  });

  it("debits the wallet (Minus ledger row)", async () => {
    setupQueries(100_000);
    applyAdminWalletAdjustment.mockResolvedValue({
      walletId: 10,
      beforeBalance: 100_000,
      afterBalance: 50_000,
      delta: -50_000,
      changed: true,
      ledgerId: 2,
      transactionType: "Minus",
    });
    const c = build();
    const ctx = makeCtx({ userId: 1, mode: "debit", amountToman: 5_000, reason: "correction" });

    await c.adminAdjustWallet(ctx);

    expect(applyAdminWalletAdjustment).toHaveBeenCalledWith(
      mockStrapi,
      expect.objectContaining({ mode: "debit", amountIrr: 50_000 }),
    );
  });

  it("set mode computes the delta vs current balance and routes to debit when lower", async () => {
    setupQueries(100_000); // 10,000 Toman
    applyAdminWalletAdjustment.mockResolvedValue({
      walletId: 10,
      beforeBalance: 100_000,
      afterBalance: 60_000,
      delta: -40_000,
      changed: true,
      ledgerId: 3,
      transactionType: "Minus",
    });
    const c = build();
    const ctx = makeCtx({ userId: 1, mode: "set", amountToman: 6_000, reason: "set lower" });

    await c.adminAdjustWallet(ctx);

    // target 6,000 Toman = 60,000 IRR; current 100,000 IRR → debit 40,000 IRR
    expect(applyAdminWalletAdjustment).toHaveBeenCalledWith(
      mockStrapi,
      expect.objectContaining({ mode: "set", amountIrr: 60_000 }),
    );
  });

  it("rejects debit when balance is insufficient", async () => {
    setupQueries(10_000);
    applyAdminWalletAdjustment.mockRejectedValue(
      new WalletAdjustmentError("INSUFFICIENT_BALANCE" as any, "Insufficient balance"),
    );
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
    expect(applyAdminWalletAdjustment).not.toHaveBeenCalled();
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
    expect(applyAdminWalletAdjustment).not.toHaveBeenCalled();
  });

  it("credits another user by id without requiring a customer role", async () => {
    setupQueries(100_000);
    applyAdminWalletAdjustment.mockResolvedValue({
      walletId: 10,
      beforeBalance: 100_000,
      afterBalance: 110_000,
      delta: 10_000,
      changed: true,
      ledgerId: 4,
      transactionType: "Add",
    });
    const c = build();
    const ctx = makeCtx({ userId: 1, mode: "credit", amountToman: 1_000, reason: "staff top-up" });

    await c.adminAdjustWallet(ctx);

    expect(mockStrapi.db.query(USER_UID).findOne).toHaveBeenCalledWith({
      where: { id: 1 },
      select: ["id"],
    });
    expect(applyAdminWalletAdjustment).toHaveBeenCalledWith(
      mockStrapi,
      expect.objectContaining({ userId: 1, mode: "credit", amountIrr: 10_000 }),
    );
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("rejects self-wallet adjustment for every administrative actor", async () => {
    const c = build();
    const ctx = makeCtx({ userId: 99, mode: "credit", amountToman: 5_000, reason: "self" });

    await c.adminAdjustWallet(ctx);

    expect(ctx.forbidden).toHaveBeenCalledWith(
      "تغییر موجودی کیف پول خودتان مجاز نیست.",
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: "SELF_WALLET_ADJUSTMENT_FORBIDDEN" }),
      }),
    );
    expect(writeAuditEvent).toHaveBeenCalledWith(
      mockStrapi,
      expect.objectContaining({
        eventKey: "security.access_denied",
        result: "denied",
        reasonCode: "SELF_WALLET_ADJUSTMENT_FORBIDDEN",
      }),
    );
    expect(applyAdminWalletAdjustment).not.toHaveBeenCalled();
  });
});
