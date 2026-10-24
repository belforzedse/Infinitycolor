/** Real PostgreSQL coverage of Mellat recovery; only provider calls and queue delivery are mocked. */
jest.mock("../../../queue/mellat", () => ({
  enqueueMellatAttempt: jest.fn(async () => undefined),
}));
// Strapi boots compiled lifecycles; staff notification delivery is another external queue boundary.
jest.mock("../../../../dist/src/queue/staff-order-alert", () => ({
  enqueueStaffOrderStartedAlert: jest.fn(async () => undefined),
}));

import {
  acceptMellatCallback,
  prepareMellatInitiation,
  processMellatAttempt,
  recordMellatInitiation,
  reconcileMellatOrder,
  sweepMellatAttempts,
} from "../../../api/payment-gateway/services/mellat-coordinator";
import { adminAdjustItemsHandler } from "../../../api/order/controllers/helpers/adminAdjustItems";
import { readMellatState } from "../../../api/payment-gateway/services/mellat-state";
import { mellatTerminalFingerprint } from "../../../api/payment-gateway/services/mellat-v3";
import { ensurePaymentAttemptDatabaseInvariants } from "../../../api/payment-attempt/services/payment-attempt-database";
import { holdWalletForAttempt } from "../../../api/local-user-wallet/services/wallet-holds";
import { releaseOrderReservation } from "../../../utils/stockReservations";
import { cancelOrderAndRelease } from "../../../api/cart/controllers/handlers/gateway-helpers";
import { runExpireStockReservationsTick } from "../../../jobs/expireStockReservations";
import { enqueueMellatAttempt } from "../../../queue/mellat";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

const TOTAL_TOMAN = 1_200_000;
const TOTAL_IRR = TOTAL_TOMAN * 10;
const WALLET_IRR = 3_500_000;
const INITIAL_WALLET_IRR = 5_000_000;
const ATTEMPT_UID = "api::payment-attempt.payment-attempt";

let strapi: any;
let f: Factories;
let provider: {
  verify: jest.SpyInstance;
  settle: jest.SpyInstance;
  reverse: jest.SpyInstance;
  inquiry: jest.SpyInstance;
};
let fixtures: Array<{ contract: { id: number } }>;

const confirmed = (resCode = 0) => ({ success: true, ambiguous: false, resCode, rawResCode: String(resCode) });
const unknown = () => ({ success: false, ambiguous: true, errorCode: "ETIMEDOUT" });

beforeAll(async () => {
  // Inert, stable terminal identity; no SDK method is allowed to reach a provider.
  process.env.MELLAT_TERMINAL_ID = "1234567";
  process.env.MELLAT_USERNAME = "integration-merchant";
  process.env.MELLAT_PASSWORD = "integration-password";
  process.env.WALLET_HOLDS_ENABLED = "true";
  strapi = await setupStrapi();
  await ensurePaymentAttemptDatabaseInvariants(strapi);
});

afterAll(async () => {
  await teardownStrapi();
  delete process.env.WALLET_HOLDS_ENABLED;
});

beforeEach(() => {
  f = makeFactories(strapi);
  fixtures = [];
  jest.clearAllMocks();
  const service = strapi.service("api::payment-gateway.mellat-v3");
  provider = {
    verify: jest.spyOn(service, "verifyTransaction").mockResolvedValue(confirmed()),
    settle: jest.spyOn(service, "settleTransaction").mockResolvedValue(confirmed()),
    reverse: jest.spyOn(service, "reverseTransaction").mockResolvedValue(confirmed(48)),
    inquiry: jest.spyOn(service, "inquiryTransaction").mockResolvedValue(confirmed(43)),
  };
});

afterEach(async () => {
  jest.restoreAllMocks();
  // Finalization writes real ledger rows outside the factory. Register them for cleanup too.
  for (const fixture of fixtures) {
    for (const row of await f.getContractTransactions(fixture.contract.id)) {
      f.remember("api::contract-transaction.contract-transaction", row.id);
    }
  }
  await f.cleanup();
});

async function seedPayment(options: { wallet?: boolean; expired?: boolean } = {}) {
  const user = await f.createUser();
  const payable = await f.createPayableOrder({
    gateway: "Mellat",
    userId: user.id,
    amountToman: TOTAL_TOMAN,
    reservedUntil: new Date(Date.now() + (options.expired ? -60_000 : 15 * 60_000)),
    items: [{ count: 2, stockCount: 10, stockReserved: 2, perAmount: TOTAL_TOMAN / 2 }],
  });
  fixtures.push(payable);
  const walletAmountIrr = options.wallet ? WALLET_IRR : 0;
  const gatewayAmountIrr = TOTAL_IRR - walletAmountIrr;
  const wallet = options.wallet
    ? await f.createWallet({ userId: user.id, balanceIrr: INITIAL_WALLET_IRR })
    : null;
  const attempt = await f.createPaymentAttempt({
    userId: user.id,
    orderId: payable.order.id,
    contractId: payable.contract.id,
    amountIrr: TOTAL_IRR,
    gateway: "mellat",
    status: "Pending",
    walletAmountIrr,
    gatewayAmountIrr,
    walletHoldStatus: "None",
  });
  if (wallet) {
    await strapi.db.transaction(async ({ trx }: any) => {
      await trx.raw("SELECT id FROM orders WHERE id = ? FOR UPDATE", [payable.order.id]);
      await trx.raw("SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE", [attempt.id]);
      expect(await holdWalletForAttempt(strapi, {
        userId: user.id, paymentAttemptId: attempt.id, amountIrr: walletAmountIrr,
      }, trx)).toMatchObject({ outcome: "held" });
    });
  }
  const refId = `CaSeSensitiveBankRef${attempt.id}`;
  const saleReferenceId = (BigInt("9007199254740993") + BigInt(attempt.id)).toString();
  const prepared = await prepareMellatInitiation(
    strapi, attempt.id, payable.order.id, gatewayAmountIrr,
  );
  expect(prepared).toMatchObject({
    saleOrderId: String(payable.order.id), amountIrr: gatewayAmountIrr,
    terminalFingerprint: mellatTerminalFingerprint(), phase: "initiating", stockProtected: false,
  });
  await recordMellatInitiation(strapi, attempt.id, {
    ...confirmed(), refId, requestedAmountIrr: gatewayAmountIrr,
    saleOrderId: String(payable.order.id), terminalFingerprint: mellatTerminalFingerprint(),
    redirectUrl: "https://gateway.test.invalid/startpay",
  });
  const callback = {
    RefId: refId, OrderId: String(payable.order.id), SaleOrderId: String(payable.order.id),
    SaleReferenceId: saleReferenceId, ResCode: "0",
  };
  return { ...payable, attempt, callback, refId, saleReferenceId, wallet, gatewayAmountIrr };
}

const loadAttempt = (id: number) => strapi.db.query(ATTEMPT_UID).findOne({ where: { id } });
const successfulLegs = async (contractId: number) =>
  (await f.getContractTransactions(contractId)).filter((row: any) => row.Status === "Success");

async function walletState(walletId: number) {
  const row = await strapi.db.connection("local_user_wallets").where({ id: walletId }).first();
  return { balanceIrr: Number(row.balance), heldIrr: Number(row.held_balance) };
}

const walletLedger = (walletId: number) => strapi.db
  .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
  .findMany({ where: { user_wallet: { id: walletId } } });

async function expireTimestamp(orderId: number) {
  await strapi.db.connection("orders").where({ id: orderId }).update({
    reserved_until: new Date(Date.now() - 60_000),
  });
}

async function expectStock(orderId: number, stockId: number, count: number, reserved: number,
  reservationStatus: string, status: string) {
  const order = await f.getOrder(orderId);
  const stock = await f.getStock(stockId);
  expect(order).toMatchObject({ Status: status, ReservationStatus: reservationStatus });
  expect(Number(stock.Count)).toBe(count);
  expect(Number(stock.reservedCount)).toBe(reserved);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Mellat durable checkout recovery", () => {
  it("settles the original bank tuple once despite duplicate callbacks and workers", async () => {
    const payment = await seedPayment();
    expect(readMellatState(await loadAttempt(payment.attempt.id))).toMatchObject({
      refId: payment.refId, saleOrderId: String(payment.order.id), amountIrr: payment.gatewayAmountIrr,
    });
    await acceptMellatCallback(strapi, payment.callback);
    expect(enqueueMellatAttempt).toHaveBeenCalledWith(payment.attempt.id, 0);
    await processMellatAttempt(strapi, payment.attempt.id);

    const params = {
      orderId: String(payment.order.id), saleOrderId: String(payment.order.id),
      saleReferenceId: payment.saleReferenceId,
    };
    expect(provider.verify).toHaveBeenCalledWith(params);
    expect(provider.settle).toHaveBeenCalledWith(params);
    expect(provider.verify).toHaveBeenCalledTimes(1);
    expect(provider.settle).toHaveBeenCalledTimes(1);
    expect(provider.reverse).not.toHaveBeenCalled();
    await expectStock(payment.order.id, payment.items[0].stockId, 8, 0, "Consumed", "Started");
    expect(await f.getContract(payment.contract.id)).toMatchObject({
      Status: "Confirmed", external_source: "Mellat", external_id: payment.saleReferenceId,
    });
    expect(await loadAttempt(payment.attempt.id)).toMatchObject({ Status: "Succeeded", nextAction: null });
    expect(readMellatState(await loadAttempt(payment.attempt.id))).toMatchObject({
      phase: "completed", stockProtected: false,
      responses: {
        pay: { resCode: 0, ambiguous: false },
        verify: { resCode: 0, rawResCode: "0", ambiguous: false },
        settle: { resCode: 0, rawResCode: "0", ambiguous: false },
      },
    });
    const legs = await successfulLegs(payment.contract.id);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      TrackId: payment.refId, external_id: payment.saleReferenceId, GatewayRefId: payment.saleReferenceId,
      SettlementGateway: "Mellat", external_source: "Mellat", GatewayStatus: "SETTLED",
    });
    expect(Number(legs[0].Amount)).toBe(payment.gatewayAmountIrr);

    expect(await acceptMellatCallback(strapi, payment.callback)).toMatchObject({ status: "Succeeded" });
    await Promise.all([
      processMellatAttempt(strapi, payment.attempt.id), processMellatAttempt(strapi, payment.attempt.id),
    ]);
    expect(provider.verify).toHaveBeenCalledTimes(1);
    expect(provider.settle).toHaveBeenCalledTimes(1);
    expect(await successfulLegs(payment.contract.id)).toHaveLength(1);
    expect((await f.getOrderLogs(payment.order.id)).filter(
      (row: any) => row.Description === "Mellat payment confirmed and settled",
    )).toHaveLength(1);
    await expectStock(payment.order.id, payment.items[0].stockId, 8, 0, "Consumed", "Started");
  });

  it.each(["verify", "settle"] as const)(
    "%s timeout keeps stock and the wallet held through release, expiry and cancellation attempts", async (method) => {
      const payment = await seedPayment({ wallet: true });
      provider[method].mockResolvedValue(unknown());
      await acceptMellatCallback(strapi, payment.callback);
      await processMellatAttempt(strapi, payment.attempt.id);

      const attempt = await loadAttempt(payment.attempt.id);
      expect(attempt).toMatchObject({ Status: "Unknown", failureCode: "MELLAT_PROVIDER_RESPONSE_UNKNOWN" });
      expect(readMellatState(attempt)).toMatchObject({ stockProtected: true, pendingOperation: "inquiry" });
      expect(attempt.WalletHoldStatus).toBe("Active");
      await expireTimestamp(payment.order.id);
      await expect(releaseOrderReservation(strapi, payment.order.id, "Expired")).rejects.toMatchObject({
        code: "MELLAT_PAYMENT_IN_PROGRESS",
      });
      expect(await runExpireStockReservationsTick(strapi, { graceSeconds: 0, batchSize: 20 })).toMatchObject({
        status: "completed", stats: { processed: 0, skipped: 1, failed: 0 },
      });
      await expect(cancelOrderAndRelease(strapi, payment.order.id, payment.contract.id,
        payment.userId, "integration_cancel")).rejects.toMatchObject({ code: "MELLAT_PAYMENT_IN_PROGRESS" });
      await expectStock(payment.order.id, payment.items[0].stockId, 10, 2, "Reserved", "Paying");
      expect(await walletState(payment.wallet!.id)).toEqual({ balanceIrr: INITIAL_WALLET_IRR, heldIrr: WALLET_IRR });
      expect(await walletLedger(payment.wallet!.id)).toHaveLength(0);
      expect(await successfulLegs(payment.contract.id)).toHaveLength(0);
      expect(provider.reverse).not.toHaveBeenCalled();
    },
  );

  it("retries only the local commit after bank settlement and atomically captures the wallet after expiry", async () => {
    const payment = await seedPayment({ wallet: true });
    const auditQuery = strapi.db.query("api::order-log.order-log");
    jest.spyOn(auditQuery, "create").mockRejectedValueOnce(new Error("forced local settlement audit failure"));
    await acceptMellatCallback(strapi, payment.callback);
    await processMellatAttempt(strapi, payment.attempt.id);

    expect(provider.settle).toHaveBeenCalledTimes(1);
    expect(await loadAttempt(payment.attempt.id)).toMatchObject({
      Status: "Unknown", failureCode: "MELLAT_LOCAL_SETTLEMENT_PENDING", WalletHoldStatus: "Active",
    });
    expect(readMellatState(await loadAttempt(payment.attempt.id))).toMatchObject({
      phase: "settled", stockProtected: true, saleReferenceId: payment.saleReferenceId,
    });
    await expectStock(payment.order.id, payment.items[0].stockId, 10, 2, "Reserved", "Paying");
    expect(await f.getContract(payment.contract.id)).toMatchObject({ Status: "Not Ready" });
    expect(await successfulLegs(payment.contract.id)).toHaveLength(0);
    expect(await walletState(payment.wallet!.id)).toEqual({ balanceIrr: INITIAL_WALLET_IRR, heldIrr: WALLET_IRR });
    expect(await walletLedger(payment.wallet!.id)).toHaveLength(0);

    await expireTimestamp(payment.order.id);
    expect(await runExpireStockReservationsTick(strapi, { graceSeconds: 0 })).toMatchObject({
      status: "completed", stats: { processed: 0, skipped: 1, failed: 0 },
    });
    await processMellatAttempt(strapi, payment.attempt.id);
    await processMellatAttempt(strapi, payment.attempt.id);
    expect(provider.verify).toHaveBeenCalledTimes(1);
    expect(provider.settle).toHaveBeenCalledTimes(1);
    expect(provider.inquiry).not.toHaveBeenCalled();
    expect(provider.reverse).not.toHaveBeenCalled();
    await expectStock(payment.order.id, payment.items[0].stockId, 8, 0, "Consumed", "Started");
    expect(await loadAttempt(payment.attempt.id)).toMatchObject({ Status: "Succeeded", WalletHoldStatus: "Captured" });
    expect(await walletState(payment.wallet!.id)).toEqual({ balanceIrr: INITIAL_WALLET_IRR - WALLET_IRR, heldIrr: 0 });
    const walletEntries = await walletLedger(payment.wallet!.id);
    expect(walletEntries).toHaveLength(1);
    expect(walletEntries[0]).toMatchObject({ Type: "Minus", Amount: String(WALLET_IRR) });
    const legs = await successfulLegs(payment.contract.id);
    expect(legs).toHaveLength(2);
    expect(Object.fromEntries(legs.map((row: any) => [row.SettlementGateway, Number(row.Amount)]))).toEqual({
      Wallet: WALLET_IRR, Mellat: payment.gatewayAmountIrr,
    });
    expect(legs.reduce((sum: number, row: any) => sum + Number(row.Amount), 0)).toBe(TOTAL_IRR);
  });

  it("fences a stale worker's bank response while a replacement worker owns the lease", async () => {
    const payment = await seedPayment();
    const firstEntered = deferred<void>();
    const firstReply = deferred<ReturnType<typeof confirmed>>();
    const inquiryEntered = deferred<void>();
    const inquiryReply = deferred<ReturnType<typeof confirmed>>();
    provider.verify.mockImplementationOnce(async () => {
      firstEntered.resolve();
      return firstReply.promise;
    });
    provider.inquiry.mockImplementationOnce(async () => {
      inquiryEntered.resolve();
      return inquiryReply.promise;
    });
    await acceptMellatCallback(strapi, payment.callback);
    const oldWorker = processMellatAttempt(strapi, payment.attempt.id);
    await firstEntered.promise;
    await processMellatAttempt(strapi, payment.attempt.id);
    expect(provider.verify).toHaveBeenCalledTimes(1);
    expect(provider.settle).not.toHaveBeenCalled();

    const oldVersion = Number((await loadAttempt(payment.attempt.id)).leaseVersion);
    await strapi.db.connection("payment_attempts").where({ id: payment.attempt.id }).update({
      lease_until: new Date(Date.now() - 1000),
    });
    const replacement = processMellatAttempt(strapi, payment.attempt.id);
    await inquiryEntered.promise;
    expect(Number((await loadAttempt(payment.attempt.id)).leaseVersion)).toBe(oldVersion + 1);
    firstReply.resolve(confirmed());
    await oldWorker;
    expect(provider.settle).not.toHaveBeenCalled();
    expect(readMellatState(await loadAttempt(payment.attempt.id))).toMatchObject({ pendingOperation: "inquiry" });

    inquiryReply.resolve(confirmed(43));
    await replacement;
    expect(provider.inquiry).toHaveBeenCalledTimes(1);
    expect(provider.verify).toHaveBeenCalledTimes(2);
    expect(provider.settle).toHaveBeenCalledTimes(1);
    expect(await successfulLegs(payment.contract.id)).toHaveLength(1);
    await expectStock(payment.order.id, payment.items[0].stockId, 8, 0, "Consumed", "Started");
  });

  it("leaves a failed reversal unresolved and releases an expired reservation only after code 48", async () => {
    const payment = await seedPayment({ expired: true, wallet: true });
    provider.reverse.mockResolvedValueOnce({ success: false, ambiguous: false, resCode: 21, rawResCode: "21" });
    await acceptMellatCallback(strapi, payment.callback);
    await processMellatAttempt(strapi, payment.attempt.id);

    const unresolved = await loadAttempt(payment.attempt.id);
    expect(unresolved).toMatchObject({ Status: "Unknown", failureCode: "MELLAT_REVERSE_21", WalletHoldStatus: "Active" });
    expect(readMellatState(unresolved)).toMatchObject({ phase: "reversing", stockProtected: false });
    expect(readMellatState(unresolved)?.reversedAt).toBeUndefined();
    expect(unresolved.providerStatus).not.toBe("REVERSED");
    await expectStock(payment.order.id, payment.items[0].stockId, 10, 2, "Reserved", "Paying");
    expect(await walletState(payment.wallet!.id)).toEqual({ balanceIrr: INITIAL_WALLET_IRR, heldIrr: WALLET_IRR });

    await processMellatAttempt(strapi, payment.attempt.id);
    const reversed = await loadAttempt(payment.attempt.id);
    expect(reversed).toMatchObject({ Status: "Cancelled", providerStatus: "REVERSED", WalletHoldStatus: "Released", nextAction: null });
    expect(readMellatState(reversed)).toMatchObject({ phase: "reversed", stockProtected: false, reversedAt: expect.any(String) });
    await expectStock(payment.order.id, payment.items[0].stockId, 10, 0, "Released", "Cancelled");
    expect(await f.getContract(payment.contract.id)).toMatchObject({ Status: "Cancelled" });
    expect(await walletState(payment.wallet!.id)).toEqual({ balanceIrr: INITIAL_WALLET_IRR, heldIrr: 0 });
    expect(await walletLedger(payment.wallet!.id)).toHaveLength(0);
    expect(await successfulLegs(payment.contract.id)).toHaveLength(0);
    expect(provider.reverse).toHaveBeenCalledTimes(2);
    expect(provider.verify).not.toHaveBeenCalled();
    expect(provider.settle).not.toHaveBeenCalled();
  });

  it("retains a success callback that arrives after a decline worker claims its lease", async () => {
    const payment = await seedPayment({ wallet: true });
    await acceptMellatCallback(strapi, { ...payment.callback, ResCode: "17", SaleReferenceId: undefined });
    const closingEntered = deferred<void>();
    const resumeClosure = deferred<void>();
    const repository = strapi.db.query(ATTEMPT_UID);
    const actualFindOne = repository.findOne.bind(repository);
    let orderLookupCount = 0;
    // Pause only the closure's initial lookup. All reads, locks and writes still use real PostgreSQL.
    const lookup = jest.spyOn(repository, "findOne").mockImplementation(async (args: any) => {
      if (args?.where?.id === payment.attempt.id && args?.where?.Gateway === "mellat") {
        orderLookupCount += 1;
        if (orderLookupCount === 2) {
          closingEntered.resolve();
          await resumeClosure.promise;
        }
      }
      return actualFindOne(args);
    });
    const decliningWorker = processMellatAttempt(strapi, payment.attempt.id);
    try {
      await closingEntered.promise;
      await acceptMellatCallback(strapi, payment.callback);
    } finally {
      resumeClosure.resolve();
    }
    await decliningWorker;
    lookup.mockRestore();

    expect(await loadAttempt(payment.attempt.id)).toMatchObject({
      Status: "Unknown", nextAction: "mellat_reconcile", WalletHoldStatus: "Active", leaseUntil: null,
    });
    expect(readMellatState(await loadAttempt(payment.attempt.id))).toMatchObject({
      callbackCode: "0", saleReferenceId: payment.saleReferenceId,
    });
    await expectStock(payment.order.id, payment.items[0].stockId, 10, 2, "Reserved", "Paying");
    expect(await walletState(payment.wallet!.id)).toEqual({ balanceIrr: INITIAL_WALLET_IRR, heldIrr: WALLET_IRR });
    expect(provider.verify).not.toHaveBeenCalled();
    expect(provider.reverse).not.toHaveBeenCalled();

    await processMellatAttempt(strapi, payment.attempt.id);
    expect(await loadAttempt(payment.attempt.id)).toMatchObject({ Status: "Succeeded", WalletHoldStatus: "Captured" });
    await expectStock(payment.order.id, payment.items[0].stockId, 8, 0, "Consumed", "Started");
    expect(provider.verify).toHaveBeenCalledTimes(1);
    expect(provider.settle).toHaveBeenCalledTimes(1);
    expect(await successfulLegs(payment.contract.id)).toHaveLength(2);
    expect(await walletLedger(payment.wallet!.id)).toHaveLength(1);
  }, 30_000);

  it("rejects mismatched callback references without replacing the saved bank tuple", async () => {
    const payment = await seedPayment();
    await expect(acceptMellatCallback(strapi, { ...payment.callback, RefId: payment.refId.toLowerCase() }))
      .rejects.toThrow("MELLAT_CALLBACK_UNCORRELATED");
    await expect(acceptMellatCallback(strapi, { ...payment.callback, SaleOrderId: String(payment.order.id + 1) }))
      .rejects.toThrow("MELLAT_CALLBACK_REFERENCE_MISMATCH");
    await expect(acceptMellatCallback(strapi, { ...payment.callback, SaleOrderId: 9007199254740992 }))
      .rejects.toThrow("MELLAT_CALLBACK_INVALID");
    await expect(acceptMellatCallback(strapi, { ...payment.callback, SaleReferenceId: 9007199254740992 }))
      .rejects.toThrow("MELLAT_CALLBACK_REFERENCE_MISSING");
    await acceptMellatCallback(strapi, payment.callback);
    await expect(acceptMellatCallback(strapi, { ...payment.callback, SaleReferenceId: "9223372036854775807" }))
      .rejects.toThrow("MELLAT_CALLBACK_REFERENCE_MISMATCH");
    expect(readMellatState(await loadAttempt(payment.attempt.id))).toMatchObject({
      refId: payment.refId, saleOrderId: String(payment.order.id), saleReferenceId: payment.saleReferenceId,
    });
    expect(provider.verify).not.toHaveBeenCalled();
  });

  it.each([1, 0])("refuses admin item reductions to %s while a card-only Mellat payment is unresolved", async (newCount) => {
    const payment = await seedPayment();
    provider.verify.mockResolvedValueOnce(unknown());
    await acceptMellatCallback(strapi, payment.callback);
    await processMellatAttempt(strapi, payment.attempt.id);
    const ctx: any = {
      params: { id: payment.order.id }, query: {},
      state: { auth: { strategy: { name: "api-token" }, credentials: { type: "full-access", id: 1, name: "inert-test-actor" } } },
      request: { body: { items: [{ orderItemId: payment.items[0].orderItemId, newCount }], reason: "integration fixture" } },
      conflict: jest.fn(), badRequest: jest.fn(), notFound: jest.fn(), internalServerError: jest.fn(),
    };
    await adminAdjustItemsHandler(strapi, ctx);
    expect(ctx.conflict).toHaveBeenCalledWith(expect.any(String), {
      data: { errorCode: "MELLAT_PAYMENT_IN_PROGRESS" },
    });
    expect(ctx.internalServerError).not.toHaveBeenCalled();
    expect(Number((await f.getContract(payment.contract.id)).Amount)).toBe(TOTAL_TOMAN);
    const item = await strapi.db.query("api::order-item.order-item").findOne({ where: { id: payment.items[0].orderItemId } });
    expect(Number(item.Count)).toBe(2);
    await expectStock(payment.order.id, payment.items[0].stockId, 10, 2, "Reserved", "Paying");
    expect(readMellatState(await loadAttempt(payment.attempt.id))?.stockProtected).toBe(true);
  });

  it("does not reopen a confirmed reversal when the successful bank callback is replayed", async () => {
    const payment = await seedPayment({ expired: true, wallet: true });
    await acceptMellatCallback(strapi, payment.callback);
    await processMellatAttempt(strapi, payment.attempt.id);
    const before = await loadAttempt(payment.attempt.id);
    expect(before.Status).toBe("Cancelled");
    expect(readMellatState(before)).toMatchObject({ phase: "reversed", stockProtected: false });
    const auditBefore = (await f.getOrderLogs(payment.order.id)).length;
    jest.mocked(enqueueMellatAttempt).mockClear();
    expect(await acceptMellatCallback(strapi, payment.callback)).toMatchObject({ status: "Cancelled" });
    await reconcileMellatOrder(strapi, payment.order.id);
    await processMellatAttempt(strapi, payment.attempt.id);
    const after = await loadAttempt(payment.attempt.id);
    expect(after).toMatchObject({ Status: "Cancelled", nextAction: null, resolvedAt: before.resolvedAt });
    expect(enqueueMellatAttempt).not.toHaveBeenCalled();
    expect(provider.reverse).toHaveBeenCalledTimes(1);
    expect((await f.getOrderLogs(payment.order.id)).length).toBe(auditBefore);
  });

  it("rolls back reversal closure if the mandatory audit fails, retaining every protected resource", async () => {
    const payment = await seedPayment({ wallet: true });
    provider.verify.mockResolvedValueOnce(unknown());
    await acceptMellatCallback(strapi, payment.callback);
    await processMellatAttempt(strapi, payment.attempt.id);
    expect(readMellatState(await loadAttempt(payment.attempt.id))?.stockProtected).toBe(true);
    provider.inquiry.mockResolvedValue(confirmed(48));
    const audit = strapi.db.query("api::order-log.order-log");
    const actualCreate = audit.create.bind(audit);
    let failAudit = true;
    const failure = jest.spyOn(audit, "create").mockImplementation(async (args: any) => {
      if (failAudit && args?.data?.Description === "Mellat reversal confirmed") {
        failAudit = false;
        throw new Error("INJECTED_REVERSAL_AUDIT_FAILURE");
      }
      return actualCreate(args);
    });
    await processMellatAttempt(strapi, payment.attempt.id);
    failure.mockRestore();
    expect(readMellatState(await loadAttempt(payment.attempt.id))?.stockProtected).toBe(true);
    await expectStock(payment.order.id, payment.items[0].stockId, 10, 2, "Reserved", "Paying");
    expect(await walletState(payment.wallet!.id)).toEqual({ balanceIrr: INITIAL_WALLET_IRR, heldIrr: WALLET_IRR });
    await processMellatAttempt(strapi, payment.attempt.id);
    expect(await loadAttempt(payment.attempt.id)).toMatchObject({ Status: "Cancelled", WalletHoldStatus: "Released" });
    await expectStock(payment.order.id, payment.items[0].stockId, 10, 0, "Released", "Cancelled");
  });

  it("retains an unknown outcome when the callback reference is completely missing", async () => {
    const payment = await seedPayment();
    await strapi.db.connection("payment_attempts").where({ id: payment.attempt.id }).update({
      created_at: new Date(Date.now() - 16 * 60_000), next_action_at: new Date(Date.now() - 1000),
    });
    const errorLog = jest.spyOn(strapi.log, "error").mockImplementation(() => undefined);
    jest.mocked(enqueueMellatAttempt).mockClear();
    expect(await sweepMellatAttempts(strapi)).toEqual({ processed: 1 });
    expect(enqueueMellatAttempt).toHaveBeenCalledWith(payment.attempt.id, 0);
    await processMellatAttempt(strapi, payment.attempt.id);
    expect(await loadAttempt(payment.attempt.id)).toMatchObject({
      Status: "Unknown", failureCode: "MELLAT_CALLBACK_REFERENCE_UNAVAILABLE", nextAction: "mellat_reconcile",
    });
    expect(provider.verify).not.toHaveBeenCalled();
    expect(provider.inquiry).not.toHaveBeenCalled();
    expect(provider.settle).not.toHaveBeenCalled();
    expect(readMellatState(await loadAttempt(payment.attempt.id))?.stockProtected).toBe(false);
    expect(readMellatState(await loadAttempt(payment.attempt.id))?.alertedAt).toEqual(expect.any(String));
    await processMellatAttempt(strapi, payment.attempt.id);
    expect(errorLog.mock.calls.filter(([message]) => String(message).includes("remains unresolved"))).toHaveLength(1);
  });

  it("enforces the native unique index for successful Mellat settlement references", async () => {
    await ensurePaymentAttemptDatabaseInvariants(strapi);
    const indexes = await strapi.db.connection.raw(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
       AND indexname IN ('idx_contract_transactions_mellat_reference', 'idx_payment_attempts_mellat_provider_reference')`,
    );
    expect(indexes.rows.map((row: any) => row.indexname).sort()).toEqual([
      "idx_contract_transactions_mellat_reference", "idx_payment_attempts_mellat_provider_reference",
    ]);
    const payment = await seedPayment();
    await acceptMellatCallback(strapi, payment.callback);
    await processMellatAttempt(strapi, payment.attempt.id);
    expect(await successfulLegs(payment.contract.id)).toHaveLength(1);

    // Rehearse an upgrade with a real native settlement already present.
    await strapi.db.connection.raw("DROP INDEX idx_contract_transactions_mellat_reference");
    const migration = require("../../../../database/migrations/2026.10.24T12.00.00.mellat-settlement-reference.js");
    await migration.up(strapi.db.connection);
    expect(await successfulLegs(payment.contract.id)).toHaveLength(1);
    await expect(strapi.db.connection.transaction(async (trx: any) => {
      await trx("contract_transactions").insert({
        type: "Gateway", amount: payment.gatewayAmountIrr, step: 1, status: "Success",
        external_source: "mElLaT", external_id: payment.saleReferenceId, date: new Date(),
      });
      // Roll back even if the index regresses and allows the forbidden write.
      throw new Error("DUPLICATE_MELLAT_REFERENCE_WAS_INSERTED");
    })).rejects.toMatchObject({ code: "23505", constraint: "idx_contract_transactions_mellat_reference" });
    expect(await successfulLegs(payment.contract.id)).toHaveLength(1);
  });
});
