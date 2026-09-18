/**
 * Last-unit reservation continuation through the real stock-check / finalize path.
 *
 * Reproduces 111459: after checkout reserves the only unit, a later checkCartStock
 * that uses global free stock (count - reserved_count = 0) must not destroy the
 * identified checkout. A second product for the same customer is not a retry.
 */
import { createCheckoutQuote } from "../../../api/cart/services/lib/checkout-quote";
import { checkCartStockOp } from "../../../api/cart/services/ops/checkCartStock";
import { releaseOrderReservation } from "../../../utils/stockReservations";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

let strapi: any;
let f: Factories;

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

async function seedCart(opts: {
  stockCount: number;
  stockReserved?: number;
  quantity: number;
  price?: number;
}) {
  const price = opts.price ?? 100000;
  const user = await f.createUser();
  const product = await f.createProduct({ status: "Active" });
  const variation = await f.createVariation({
    productId: product.id,
    stockCount: opts.stockCount,
    stockReserved: opts.stockReserved ?? 0,
    price,
  });
  const cart = await f.createCart({ userId: user.id });
  const cartItem = await f.createCartItem({
    cartId: cart.id,
    variationId: variation.id,
    count: opts.quantity,
    price,
  });
  return { user, product, variation, cart, cartItem, price };
}

async function rememberFinalize(result: {
  order?: { id?: number };
  contract?: { id?: number };
  paymentAttempt?: { id?: number };
}) {
  if (result.order?.id) {
    f.remember("api::order.order", result.order.id);
    const items = await strapi.db.query("api::order-item.order-item").findMany({
      where: { order: { id: result.order.id } },
    });
    for (const item of items) {
      f.remember("api::order-item.order-item", item.id);
    }
  }
  if (result.contract?.id) f.remember("api::contract.contract", result.contract.id);
  if (result.paymentAttempt?.id) {
    f.remember("api::payment-attempt.payment-attempt", result.paymentAttempt.id);
  }
}

function stockCount(stock: { Count?: unknown; count?: unknown }): number {
  return Number(stock.Count ?? stock.count);
}

function stockReserved(stock: {
  reservedCount?: unknown;
  reserved_count?: unknown;
}): number {
  return Number(stock.reservedCount ?? stock.reserved_count);
}

async function placeOrder(userId: number, attemptId: string) {
  const cartService = strapi.service("api::cart.cart");
  const quote = await createCheckoutQuote(strapi, userId, {
    shippingCost: 0,
    gateway: "mellat",
  });
  const result = await cartService.finalizeCartToOrder(userId, {
    gateway: "mellat",
    attemptId,
    quoteHash: quote.quoteHash,
    shippingCost: 0,
  });
  await rememberFinalize(result);
  return { quote, result };
}

describe("checkout reservation continuation", () => {
  it("A. last unit: return through stock-check keeps the original order and hold", async () => {
    const seeded = await seedCart({ stockCount: 1, quantity: 1 });
    const attemptId = `attempt-last-${seeded.user.id}`;

    const first = await placeOrder(seeded.user.id, attemptId);
    expect(first.result.success).toBe(true);
    expect(first.result.replayed).not.toBe(true);
    expect(first.result.order?.id).toBeTruthy();

    const afterReserve = await f.getStock(seeded.variation.stockId);
    expect(stockCount(afterReserve)).toBe(1);
    expect(stockReserved(afterReserve)).toBe(1);

    const unscoped = await checkCartStockOp(strapi, seeded.user.id);
    expect(unscoped.valid).toBe(false);
    expect(unscoped.cartIsEmpty).toBe(true);

    await f.createCartItem({
      cartId: seeded.cart.id,
      variationId: seeded.variation.id,
      count: 1,
      price: seeded.price,
    });

    const scoped = await checkCartStockOp(strapi, seeded.user.id, { attemptId });
    expect(scoped.valid).toBe(true);
    expect(scoped.reservationOutcome).toBe("held");
    expect(scoped.cart?.cart_items?.length).toBe(1);

    const changedPayable = await strapi.service("api::cart.cart").finalizeCartToOrder(
      seeded.user.id,
      {
        gateway: "mellat",
        attemptId,
        quoteHash: "sha256:changed-after-discount",
      },
    );
    const resumed = await strapi.service("api::cart.cart").finalizeCartToOrder(seeded.user.id, {
      gateway: "mellat",
      attemptId,
      quoteHash: first.quote.quoteHash,
    });

    expect(changedPayable.success).toBe(false);
    expect(changedPayable.errorCode).toBe("CHECKOUT_ATTEMPT_CONFLICT");
    expect(resumed.success).toBe(true);
    expect(resumed.replayed).toBe(true);
    expect(resumed.order.id).toBe(first.result.order.id);

    const stock = await f.getStock(seeded.variation.stockId);
    expect(stockCount(stock)).toBe(1);
    expect(stockReserved(stock)).toBe(1);

    const attempts = await strapi.db.query("api::payment-attempt.payment-attempt").findMany({
      where: { user: { id: seeded.user.id } },
    });
    expect(attempts).toHaveLength(1);
  });

  it("B. partial free stock must not reduce the original reserved quantity", async () => {
    const seeded = await seedCart({ stockCount: 3, quantity: 2 });
    const attemptId = `attempt-partial-${seeded.user.id}`;
    const first = await placeOrder(seeded.user.id, attemptId);
    expect(first.result.success).toBe(true);

    const unscoped = await checkCartStockOp(strapi, seeded.user.id);
    expect(unscoped.valid).toBe(false);
    expect(Number(unscoped.cart?.cart_items?.[0]?.Count)).toBe(1);

    await strapi.db.query("api::cart-item.cart-item").update({
      where: { id: seeded.cartItem.id },
      data: { Count: 2, Sum: seeded.price * 2 },
    });

    const scoped = await checkCartStockOp(strapi, seeded.user.id, { attemptId });
    expect(scoped.valid).toBe(true);
    expect(Number(scoped.cart?.cart_items?.[0]?.Count)).toBe(2);

    const retry = await strapi.service("api::cart.cart").finalizeCartToOrder(seeded.user.id, {
      gateway: "mellat",
      attemptId,
      quoteHash: first.quote.quoteHash,
    });
    expect(retry.replayed).toBe(true);
    expect(retry.order.id).toBe(first.result.order.id);
    expect(retry.financialSummary?.total).toBe(first.result.financialSummary?.total);

    const stock = await f.getStock(seeded.variation.stockId);
    expect(stockCount(stock)).toBe(3);
    expect(stockReserved(stock)).toBe(2);
  });

  it("C. another customer and a second order cannot take the reserved last unit", async () => {
    const owner = await seedCart({ stockCount: 1, quantity: 1 });
    const attemptId = `attempt-owner-${owner.user.id}`;
    await placeOrder(owner.user.id, attemptId);

    const other = await f.createUser();
    const otherCart = await f.createCart({ userId: other.id });
    await f.createCartItem({
      cartId: otherCart.id,
      variationId: owner.variation.id,
      count: 1,
      price: 100000,
    });
    const otherCheck = await checkCartStockOp(strapi, other.id);
    expect(otherCheck.valid).toBe(false);
    expect(otherCheck.cartIsEmpty).toBe(true);

    await f.createCartItem({
      cartId: otherCart.id,
      variationId: owner.variation.id,
      count: 1,
      price: 100000,
    });
    const spoofed = await checkCartStockOp(strapi, other.id, { attemptId });
    expect(spoofed.valid).toBe(false);
    expect(spoofed.reservationOutcome).toBeUndefined();

    const sameUserSecond = await strapi.service("api::cart.cart").finalizeCartToOrder(owner.user.id, {
      gateway: "mellat",
      attemptId: `attempt-second-${owner.user.id}`,
      quoteHash: "sha256:new-order",
    });
    expect(sameUserSecond.success).toBe(false);

    const free = await seedCart({ stockCount: 4, quantity: 1 });
    const unrelated = await placeOrder(free.user.id, `attempt-free-${free.user.id}`);
    expect(unrelated.result.success).toBe(true);
    expect(unrelated.result.replayed).not.toBe(true);
  });

  it("D. empty mutable cart still resumes the identified payable order", async () => {
    const seeded = await seedCart({ stockCount: 1, quantity: 1 });
    const attemptId = `attempt-empty-${seeded.user.id}`;
    const first = await placeOrder(seeded.user.id, attemptId);

    await strapi.db.query("api::cart-item.cart-item").delete({ where: { id: seeded.cartItem.id } });

    const emptyCheck = await checkCartStockOp(strapi, seeded.user.id, { attemptId });
    expect(emptyCheck.cart?.cart_items?.length || 0).toBe(0);
    expect(emptyCheck.reservationOutcome).toBe("held");
    expect(emptyCheck.heldOrderId).toBe(first.result.order.id);

    const resumed = await strapi.service("api::cart.cart").finalizeCartToOrder(seeded.user.id, {
      gateway: "mellat",
      attemptId,
      quoteHash: first.quote.quoteHash,
    });
    expect(resumed.success).toBe(true);
    expect(resumed.replayed).toBe(true);
    expect(resumed.order.id).toBe(first.result.order.id);
    expect(resumed.financialSummary?.total).toBe(first.result.financialSummary?.total);

    const stock = await f.getStock(seeded.variation.stockId);
    expect(stockReserved(stock)).toBe(1);
  });

  it("E. expired reservation is not treated as a current hold or resurrected", async () => {
    const seeded = await seedCart({ stockCount: 1, quantity: 1 });
    const attemptId = `attempt-expired-${seeded.user.id}`;
    const first = await placeOrder(seeded.user.id, attemptId);

    await releaseOrderReservation(strapi, first.result.order.id, "Expired");

    const scoped = await checkCartStockOp(strapi, seeded.user.id, { attemptId });
    expect(scoped.reservationOutcome).toBe("expired");

    const resumed = await strapi.service("api::cart.cart").finalizeCartToOrder(seeded.user.id, {
      gateway: "mellat",
      attemptId,
      quoteHash: first.quote.quoteHash,
    });
    expect(resumed.success).toBe(false);
    expect(resumed.errorCode).toBe("RESERVATION_EXPIRED");

    const stock = await f.getStock(seeded.variation.stockId);
    expect(stockCount(stock)).toBe(1);
    expect(stockReserved(stock)).toBe(0);
  });
});
