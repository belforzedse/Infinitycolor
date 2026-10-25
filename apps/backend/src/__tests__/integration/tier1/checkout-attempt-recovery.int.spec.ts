/** Real controller/database recovery; only the bank and external queues are mocked. */
jest.mock("../../../queue/mellat", () => ({ enqueueMellatAttempt: jest.fn(async () => undefined) }));
jest.mock("../../../../dist/src/queue/mellat", () => ({ enqueueMellatAttempt: jest.fn(async () => undefined) }));
jest.mock("../../../../dist/src/queue/staff-order-alert", () => ({
  enqueueStaffOrderStartedAlert: jest.fn(async () => undefined),
}));

import path from "node:path";
import { createCheckoutQuote } from "../../../api/cart/services/lib/checkout-quote";
import { buildWalletCheckoutContext } from "../../../api/cart/services/lib/wallet-checkout";
import { refreshWalletReadiness } from "../../../api/local-user-wallet/services/wallet-readiness";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

const ATTEMPT_UID = "api::payment-attempt.payment-attempt";
const TOTAL_TOMAN = 1_200_000;
const WALLET_TOMAN = 350_000;
const INITIAL_WALLET_IRR = 5_000_000;
const envKeys = ["MELLAT_CHECKOUT_MODE", "WALLET_HOLDS_ENABLED", "WALLET_CHECKOUT_SPLIT_ENABLED"] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let strapi: any;
let f: Factories;
let checkoutUsers: number[];

beforeAll(async () => {
  process.env.MELLAT_CHECKOUT_MODE = "live";
  process.env.WALLET_HOLDS_ENABLED = "true";
  process.env.WALLET_CHECKOUT_SPLIT_ENABLED = "true";
  strapi = await setupStrapi();
  await refreshWalletReadiness(strapi);
  // The registered controller/cart service runs compiled code; evaluate its
  // readiness cache against the same disposable database as source quote code.
  const distDir = process.env.INTEGRATION_DIST_DIR || path.resolve(__dirname, "../../../../dist");
  await require(path.join(distDir, "src/api/local-user-wallet/services/wallet-readiness"))
    .refreshWalletReadiness(strapi);
});

afterAll(async () => {
  await teardownStrapi();
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  f = makeFactories(strapi);
  checkoutUsers = [];
});

afterEach(async () => {
  jest.restoreAllMocks();
  // Real finalize writes rows outside the factory; collect surviving rows too.
  for (const userId of checkoutUsers) {
    for (const order of await strapi.db.query("api::order.order").findMany({ where: { user: { id: userId } } })) {
      f.remember("api::order.order", order.id);
      for (const item of await strapi.db.query("api::order-item.order-item").findMany({ where: { order: { id: order.id } } })) {
        f.remember("api::order-item.order-item", item.id);
      }
    }
    for (const contract of await strapi.db.query("api::contract.contract").findMany({ where: { local_user: { id: userId } } })) {
      f.remember("api::contract.contract", contract.id);
    }
    for (const attempt of await strapi.db.query(ATTEMPT_UID).findMany({ where: { user: { id: userId } } })) {
      f.remember(ATTEMPT_UID, attempt.id);
    }
  }
  await f.cleanup();
});

function context(user: any, body: any = {}, query: any = {}) {
  const ctx: any = { state: { user }, request: { body, query }, query, set: jest.fn(), status: 200 };
  for (const [method, status] of Object.entries({ badRequest: 400, unauthorized: 401, forbidden: 403, conflict: 409, internalServerError: 500 })) {
    ctx[method] = jest.fn((_message: string, details: any) => {
      ctx.status = status;
      return { error: { status, details } };
    });
  }
  return ctx;
}

async function lookup(user: any, attemptId: string) {
  const ctx = context(user, {}, { attemptId });
  const result = await strapi.controller("api::cart.cart").checkoutAttempt(ctx);
  expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  return { ctx, result };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 8_000);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

async function seedCheckout() {
  const user = await f.createUser();
  checkoutUsers.push(user.id);
  const wallet = await f.createWallet({ userId: user.id, balanceIrr: INITIAL_WALLET_IRR });
  const product = await f.createProduct({ status: "Active" });
  const variation = await f.createVariation({ productId: product.id, price: TOTAL_TOMAN, stockCount: 5 });
  const cart = await f.createCart({ userId: user.id });
  await f.createCartItem({ cartId: cart.id, variationId: variation.id, count: 1, price: TOTAL_TOMAN });
  const address = await f.createAddress({ userId: user.id });
  const shipping = await strapi.db.query("api::shipping.shipping").create({
    data: { Title: `Recovery fixture ${user.id}`, Code: `recovery-${user.id}`, Price: 0, IsActive: true },
  });
  f.remember("api::shipping.shipping", shipping.id);
  await f.createPaymentGateway({ title: "Mellat", isActive: true });
  await f.createPaymentGateway({ title: "Wallet", isActive: true });
  const walletContext = await buildWalletCheckoutContext(strapi, user.id, {
    selectedGateway: "mellat", requestedWalletAmount: WALLET_TOMAN,
  });
  expect(walletContext.capabilities.splitEnabled).toBe(true);
  const quote = await createCheckoutQuote(strapi, user.id, {
    gateway: "mellat", shippingId: shipping.id, shippingCost: 0, resolveAllocation: walletContext.resolve,
  });
  const payload = {
    gateway: "mellat", attemptId: `before-insert-${user.id}`, quoteHash: quote.quoteHash,
    shipping: shipping.id, addressId: address.id, walletAmountToman: WALLET_TOMAN,
  };
  return { user, wallet, variation, payload };
}

describe("checkout attempt recovery against PostgreSQL", () => {
  it("returns an owned attempt's populated order without leaking private provider fields", async () => {
    const user = await f.createUser();
    const order = await f.createOrder({ userId: user.id });
    const contract = await f.createContract({ userId: user.id });
    const attempt = await f.createPaymentAttempt({ userId: user.id, orderId: order.id, contractId: contract.id, amountIrr: 100_000 });
    await strapi.db.query(ATTEMPT_UID).update({
      where: { id: attempt.id }, data: { providerReference: "private-bank-reference", providerResponse: { privateEvidence: true } },
    });
    expect((await lookup(user, attempt.attemptId)).result).toEqual({ data: {
      success: true, lookup: "found", attempt: {
        attemptId: attempt.attemptId, status: "Created", quoteHash: attempt.quoteHash, orderId: order.id,
      },
    } });
  });

  it("makes another customer's attempt indistinguishable from a nonexistent one", async () => {
    const owner = await f.createUser();
    const other = await f.createUser();
    const order = await f.createOrder({ userId: owner.id });
    const contract = await f.createContract({ userId: owner.id });
    const attempt = await f.createPaymentAttempt({ userId: owner.id, orderId: order.id, contractId: contract.id, amountIrr: 100_000 });
    const missing = { data: { success: true, lookup: "missing" } };
    expect((await lookup(other, attempt.attemptId)).result).toEqual(missing);
    expect((await lookup(other, "does-not-exist")).result).toEqual(missing);
  });

  it("returns 503 rather than missing when PostgreSQL rejects the lookup, then recovers", async () => {
    const user = await f.createUser();
    const repository = strapi.db.query(ATTEMPT_UID);
    const failure = jest.spyOn(repository, "findOne").mockImplementationOnce(async () => {
      // A genuine PostgreSQL error, isolated from every application transaction.
      return strapi.db.connection.raw("SELECT 1 / 0");
    });
    try {
      const unavailable = await lookup(user, "lookup-during-database-fault");
      expect(unavailable.ctx.status).toBe(503);
      expect(unavailable.result).toEqual({ data: {
        success: false, lookup: "unavailable", errorCode: "CHECKOUT_ATTEMPT_LOOKUP_UNAVAILABLE",
      } });
    } finally {
      failure.mockRestore();
    }
    expect((await lookup(user, "lookup-during-database-fault")).result).toEqual({ data: { success: true, lookup: "missing" } });
  });

  it("keeps a missing-before-insert retry on one financial attempt and one provider initiation", async () => {
    const seeded = await seedCheckout();
    const insertionEntered = deferred();
    const resumeInsertion = deferred();
    const retryOrderCreated = deferred();
    const bankEntered = deferred();
    const bankReply = deferred();
    const attempts = strapi.db.query(ATTEMPT_UID);
    const actualCreateAttempt = attempts.create.bind(attempts);
    let paused = false;
    const insertion = jest.spyOn(attempts, "create").mockImplementation(async (args: any) => {
      if (!paused && args?.data?.attemptId === seeded.payload.attemptId) {
        paused = true;
        insertionEntered.resolve();
        await resumeInsertion.promise;
      }
      return actualCreateAttempt(args);
    });
    const orders = strapi.db.query("api::order.order");
    const actualCreateOrder = orders.create.bind(orders);
    let orderCreates = 0;
    const orderCreation = jest.spyOn(orders, "create").mockImplementation(async (args: any) => {
      const row = await actualCreateOrder(args);
      if (Number(args?.data?.user) === seeded.user.id && ++orderCreates === 2) retryOrderCreated.resolve();
      return row;
    });
    const bank = jest.spyOn(strapi.service("api::payment-gateway.mellat-v3"), "requestPayment")
      .mockImplementation(async ({ orderId }: any) => {
        bankEntered.resolve();
        await bankReply.promise;
        return { success: true, ambiguous: false, resCode: 0, refId: `recovery-ref-${orderId}`,
          redirectUrl: "https://bank.test.invalid/startpay", redirectMethod: "POST" };
      });
    const originalCtx = context(seeded.user, { ...seeded.payload });
    const retryCtx = context(seeded.user, { ...seeded.payload });
    const original = strapi.controller("api::cart.cart").finalizeToOrder(originalCtx);
    let retry: Promise<any> | undefined;
    try {
      await waitFor(insertionEntered.promise, "original attempt insertion");
      expect((await lookup(seeded.user, seeded.payload.attemptId)).result).toEqual({ data: { success: true, lookup: "missing" } });
      expect(await attempts.count({ where: { attemptId: seeded.payload.attemptId } })).toBe(0);
      retry = strapi.controller("api::cart.cart").finalizeToOrder(retryCtx);
      await waitFor(retryOrderCreated.promise, "retry's uncommitted order");
      resumeInsertion.resolve();
      await waitFor(bankEntered.promise, "claimed bank initiation");
      await waitFor(Promise.race([original, retry]), "losing request to return while bank request is pending");
      expect(bank).toHaveBeenCalledTimes(1);
      bankReply.resolve();
      const responses = await Promise.all([original, retry]);
      expect(responses.some((response) => response?.data?.success === true)).toBe(true);
      expect(originalCtx.internalServerError).not.toHaveBeenCalled();
      expect(retryCtx.internalServerError).not.toHaveBeenCalled();
      expect(retryCtx.request.body).toEqual(originalCtx.request.body);

      const survivingAttempts = await attempts.findMany({
        where: { user: { id: seeded.user.id } }, populate: { order: true, contract: true },
      });
      expect(survivingAttempts).toHaveLength(1);
      const attempt = survivingAttempts[0];
      expect(attempt).toMatchObject({
        attemptId: seeded.payload.attemptId, quoteHash: seeded.payload.quoteHash,
        Status: "Redirected", WalletHoldStatus: "Active", WalletAmount: String(WALLET_TOMAN * 10),
      });
      expect(await orders.count({ where: { user: { id: seeded.user.id } } })).toBe(1);
      expect(await strapi.db.query("api::contract.contract").count({ where: { local_user: { id: seeded.user.id } } })).toBe(1);
      expect(await strapi.db.query("api::order-item.order-item").count({ where: { order: { user: { id: seeded.user.id } } } })).toBe(1);
      expect(attempt.order).toMatchObject({ Status: "Paying", ReservationStatus: "Reserved" });
      expect(await f.getStock(seeded.variation.stockId)).toMatchObject({ Count: 5, reservedCount: 1 });
      const wallet = await strapi.db.connection("local_user_wallets").where({ id: seeded.wallet.id }).first();
      expect(Number(wallet.balance)).toBe(INITIAL_WALLET_IRR);
      expect(Number(wallet.held_balance)).toBe(WALLET_TOMAN * 10);
      expect(await strapi.db.query("api::local-user-wallet-transaction.local-user-wallet-transaction")
        .count({ where: { user_wallet: { id: seeded.wallet.id } } })).toBe(0);
      expect(bank).toHaveBeenCalledTimes(1);
      expect(bank).toHaveBeenCalledWith(expect.objectContaining({
        orderId: attempt.order.id, amount: TOTAL_TOMAN - WALLET_TOMAN,
      }));
      expect((await lookup(seeded.user, seeded.payload.attemptId)).result).toEqual({ data: {
        success: true, lookup: "found", attempt: {
          attemptId: seeded.payload.attemptId, status: "Redirected", quoteHash: seeded.payload.quoteHash, orderId: attempt.order.id,
        },
      } });
    } finally {
      resumeInsertion.resolve();
      bankReply.resolve();
      await Promise.allSettled([original, ...(retry ? [retry] : [])]);
      insertion.mockRestore();
      orderCreation.mockRestore();
      bank.mockRestore();
    }
  }, 30_000);
});
