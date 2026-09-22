/**
 * Lock-order proof: settlement and expiry must never deadlock.
 *
 * Every path that touches money takes its rows in one order —
 * `orders` → `payment_attempts` → `product_stocks` → `local_user_wallets`.
 * A helper that grabs the wallet before the stock it shares with another
 * order re-introduces a cycle no caller can fix, which is why this is asserted
 * against a real Postgres rather than reviewed by eye.
 *
 * The interleaving is built, not slept into: two barrier transactions hold the
 * contended stock row and the contended wallet row, each contender is released
 * only once the database reports it blocked, and the final state is read back
 * from disk.
 */
import { finalizeGatewaySettlement } from "../../../api/order/controllers/helpers/gatewaySettlement";
import { claimPaymentAttemptForInitiation } from "../../../api/payment-attempt/services/claim-payment-attempt";
import { createCheckoutQuote } from "../../../api/cart/services/lib/checkout-quote";
import { buildWalletCheckoutContext } from "../../../api/cart/services/lib/wallet-checkout";
import { releaseOrderReservation } from "../../../utils/stockReservations";
import { refreshWalletReadiness } from "../../../api/local-user-wallet/services/wallet-readiness";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

let strapi: any;
let f: Factories;

const PRICE_TOMAN = 400_000;
const WALLET_TOMAN = 100_000;

beforeAll(async () => {
  process.env.WALLET_HOLDS_ENABLED = "true";
  process.env.WALLET_CHECKOUT_SPLIT_ENABLED = "true";
  strapi = await setupStrapi();
  await refreshWalletReadiness(strapi);
});

afterAll(async () => {
  await teardownStrapi();
  delete process.env.WALLET_HOLDS_ENABLED;
  delete process.env.WALLET_CHECKOUT_SPLIT_ENABLED;
});

beforeEach(async () => {
  f = makeFactories(strapi);
  await f.createPaymentGateway({ title: "Wallet", isActive: true });
  await f.createPaymentGateway({ title: "ZarinPal", isActive: true });
});

afterEach(async () => {
  await f.cleanup();
});

/** Number of backends currently parked on a lock in this database. */
async function blockedBackends(): Promise<number> {
  const result = await strapi.db.connection.raw(
    `SELECT COUNT(*)::int AS count
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'`,
  );
  return Number(result.rows[0].count);
}

/** Waits for the database to report `expected` blocked backends. */
async function waitForBlocked(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await blockedBackends()) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expected} blocked backend(s)`);
}

async function rememberFinalize(result: any) {
  if (result?.order?.id) {
    f.remember("api::order.order", result.order.id);
    const items = await strapi.db.query("api::order-item.order-item").findMany({
      where: { order: { id: result.order.id } },
    });
    for (const item of items) f.remember("api::order-item.order-item", item.id);
  }
  if (result?.contract?.id) f.remember("api::contract.contract", result.contract.id);
  if (result?.paymentAttempt?.id) {
    f.remember("api::payment-attempt.payment-attempt", result.paymentAttempt.id);
  }
}

async function placeMixedOrder(userId: number, cartId: number, variationId: number, attemptId: string) {
  await f.createCartItem({
    cartId,
    variationId,
    count: 1,
    price: PRICE_TOMAN,
  });
  const context = await buildWalletCheckoutContext(strapi, userId, {
    selectedGateway: "zarinpal",
    requestedWalletAmount: WALLET_TOMAN,
  });
  const quote = await createCheckoutQuote(strapi, userId, {
    shippingCost: 0,
    gateway: "zarinpal",
    resolveAllocation: context.resolve,
  });
  const result = await strapi.service("api::cart.cart").finalizeCartToOrder(userId, {
    gateway: "zarinpal",
    attemptId,
    quoteHash: quote.quoteHash,
    shippingCost: 0,
    walletAmountToman: WALLET_TOMAN,
  });
  await rememberFinalize(result);
  expect(result.success).toBe(true);
  return result;
}

describe("settlement against expiry on shared rows", () => {
  it("completes both without a deadlock when they contend for the same stock and wallet", async () => {
    const user = await f.createUser();
    await f.createWallet({ userId: user.id, balanceIrr: 10_000_000 });
    const product = await f.createProduct({ status: "Active" });
    const variation = await f.createVariation({
      productId: product.id,
      stockCount: 10,
      price: PRICE_TOMAN,
    });
    const cart = await f.createCart({ userId: user.id });

    // Two independent checkouts of the same customer, same product: they share
    // one product_stocks row and one wallet row.
    const orderA = await placeMixedOrder(user.id, cart.id, variation.id, `lock-a-${user.id}`);
    const orderB = await placeMixedOrder(user.id, cart.id, variation.id, `lock-b-${user.id}`);
    await claimPaymentAttemptForInitiation(strapi, Number(orderA.paymentAttempt.id));

    const walletRow = await strapi.db.connection.raw(
      `SELECT local_user_wallet_id AS id FROM local_user_wallets_user_links WHERE user_id = ?`,
      [user.id],
    );
    const walletId = Number(walletRow.rows[0].id);

    const stockBarrier = await strapi.db.connection.transaction();
    await stockBarrier.raw("SELECT id FROM product_stocks WHERE id = ? FOR UPDATE", [
      variation.stockId,
    ]);
    const walletBarrier = await strapi.db.connection.transaction();
    await walletBarrier.raw("SELECT id FROM local_user_wallets WHERE id = ? FOR UPDATE", [
      walletId,
    ]);

    // A: settles through the gateway path. Locks its order and attempt, then
    // parks on the contended stock row.
    const settlement = finalizeGatewaySettlement(strapi, {
      orderId: Number(orderA.order.id),
      contractId: Number(orderA.contract.id),
      paymentAttemptId: Number(orderA.paymentAttempt.id),
      gateway: "SamanKish",
      contractTransactionData: { Amount: (PRICE_TOMAN - WALLET_TOMAN) * 10 },
      auditDescription: "lock order test",
      auditChanges: {},
    });
    await waitForBlocked(1);

    // B: expires. It must reach the stock row before it takes the wallet; if it
    // takes the wallet first it will hold the row A needs while waiting for the
    // row A holds.
    const expiry = releaseOrderReservation(strapi, Number(orderB.order.id), "Expired");
    await waitForBlocked(2);

    await walletBarrier.commit();
    await stockBarrier.commit();

    const [settlementResult, expiryResult] = await Promise.all([settlement, expiry]);
    expect(settlementResult.outcome).toBe("settled");
    expect(expiryResult.outcome).toBe("released");

    const after = await strapi.db.connection.raw(
      `SELECT balance, held_balance FROM local_user_wallets WHERE id = ?`,
      [walletId],
    );
    // A's hold was spent, B's was handed back: nothing is left reserved.
    expect(Number(after.rows[0].balance)).toBe(10_000_000 - WALLET_TOMAN * 10);
    expect(Number(after.rows[0].held_balance)).toBe(0);

    const holds = await strapi.db.connection.raw(
      `SELECT wallet_hold_status FROM payment_attempts WHERE id IN (?, ?) ORDER BY id`,
      [Number(orderA.paymentAttempt.id), Number(orderB.paymentAttempt.id)],
    );
    expect(holds.rows.map((row: any) => row.wallet_hold_status)).toEqual([
      "Captured",
      "Released",
    ]);
  });
});
