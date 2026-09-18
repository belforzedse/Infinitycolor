/**
 * Last-unit reservation continuation through the real stock-check / finalize path.
 *
 * After checkout reserves the only unit, checkCartStock must credit the shopper's
 * own live hold even without a client attempt id, so returning from the gateway
 * cannot wipe the cart. A second product for the same customer is not a retry.
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
    expect(unscoped.valid).toBe(true);
    expect(unscoped.reservationOutcome).toBe("held");
    expect(unscoped.resumableCheckout?.attemptId).toBe(attemptId);
    expect(unscoped.resumableCheckout?.quoteHash).toBe(first.quote.quoteHash);
    expect(unscoped.cart?.cart_items?.length).toBe(1);

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
    expect(unscoped.valid).toBe(true);
    expect(Number(unscoped.cart?.cart_items?.[0]?.Count)).toBe(2);
    expect(unscoped.resumableCheckout?.attemptId).toBe(attemptId);

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
    const first = await placeOrder(owner.user.id, attemptId);

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
      gateway: "samankish",
      attemptId: `attempt-second-${owner.user.id}`,
      quoteHash: "sha256:new-order",
    });
    expect(sameUserSecond.success).toBe(false);
    expect(sameUserSecond.errorCode).not.toBe("PAYMENT_IN_PROGRESS");

    const ownerResume = await strapi.service("api::cart.cart").finalizeCartToOrder(owner.user.id, {
      gateway: "mellat",
      attemptId,
      quoteHash: first.quote.quoteHash,
    });
    expect(ownerResume.success).toBe(true);
    expect(ownerResume.replayed).toBe(true);

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
    expect(scoped.resumableCheckout == null).toBe(true);

    const unscoped = await checkCartStockOp(strapi, seeded.user.id);
    expect(unscoped.reservationOutcome).not.toBe("held");
    expect(unscoped.resumableCheckout == null).toBe(true);

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

  it("G. lost client identity still credits the live hold and can replay finalize", async () => {
    const seeded = await seedCart({ stockCount: 1, quantity: 1 });
    const attemptId = `attempt-lost-${seeded.user.id}`;
    const first = await placeOrder(seeded.user.id, attemptId);
    expect(first.result.success).toBe(true);

    const recovered = await checkCartStockOp(strapi, seeded.user.id);
    expect(recovered.valid).toBe(true);
    expect(recovered.cart?.cart_items?.length).toBe(1);
    expect(recovered.resumableCheckout?.attemptId).toBe(attemptId);
    expect(recovered.resumableCheckout?.quoteHash).toBe(first.quote.quoteHash);

    const resumed = await strapi.service("api::cart.cart").finalizeCartToOrder(seeded.user.id, {
      gateway: "mellat",
      attemptId: recovered.resumableCheckout!.attemptId,
      quoteHash: recovered.resumableCheckout!.quoteHash,
    });
    expect(resumed.success).toBe(true);
    expect(resumed.replayed).toBe(true);
    expect(resumed.order.id).toBe(first.result.order.id);
  });

  it("F. a new attempt with free stock creates a second order on another gateway", async () => {
    const seeded = await seedCart({ stockCount: 2, quantity: 1 });
    const firstAttemptId = `attempt-first-${seeded.user.id}`;
    const first = await placeOrder(seeded.user.id, firstAttemptId);
    expect(first.result.success).toBe(true);

    const secondQuote = await createCheckoutQuote(strapi, seeded.user.id, {
      shippingCost: 0,
      gateway: "samankish",
    });
    const second = await strapi.service("api::cart.cart").finalizeCartToOrder(seeded.user.id, {
      gateway: "samankish",
      attemptId: `attempt-second-${seeded.user.id}`,
      quoteHash: secondQuote.quoteHash,
      shippingCost: 0,
    });
    await rememberFinalize(second);

    expect(second.success).toBe(true);
    expect(second.replayed).not.toBe(true);
    expect(second.order.id).not.toBe(first.result.order.id);

    const resumed = await strapi.service("api::cart.cart").finalizeCartToOrder(seeded.user.id, {
      gateway: "mellat",
      attemptId: firstAttemptId,
      quoteHash: first.quote.quoteHash,
    });
    expect(resumed.success).toBe(true);
    expect(resumed.replayed).toBe(true);
    expect(resumed.order.id).toBe(first.result.order.id);
  });

  it("H. an attempt without a linked order is completed on retry instead of expiry", async () => {
    const seeded = await seedCart({ stockCount: 2, quantity: 1 });
    const attemptId = `attempt-orphan-${seeded.user.id}`;
    const quote = await createCheckoutQuote(strapi, seeded.user.id, {
      shippingCost: 0,
      gateway: "mellat",
    });
    const orphan = await strapi.db.query("api::payment-attempt.payment-attempt").create({
      data: {
        attemptId,
        quoteHash: quote.quoteHash,
        quoteSnapshot: quote,
        Status: "Created",
        Gateway: "mellat",
        Amount: Math.round(quote.financialSummary.total * 10),
        user: seeded.user.id,
      },
    });
    f.remember("api::payment-attempt.payment-attempt", orphan.id);

    const result = await strapi.service("api::cart.cart").finalizeCartToOrder(seeded.user.id, {
      gateway: "mellat",
      attemptId,
      quoteHash: quote.quoteHash,
      shippingCost: 0,
    });
    await rememberFinalize(result);

    expect({
      success: result.success,
      errorCode: result.errorCode,
      message: result.message,
    }).toEqual(expect.objectContaining({ success: true }));
    expect(result.errorCode).not.toBe("RESERVATION_EXPIRED");
    expect(result.errorCode).not.toBe("CHECKOUT_ATTEMPT_CONFLICT");
    expect(result.order?.id).toBeTruthy();

    const attempts = await strapi.db.query("api::payment-attempt.payment-attempt").findMany({
      where: { attemptId },
      populate: { order: true },
    });
    expect(attempts).toHaveLength(1);
    expect(Number(attempts[0].order?.id ?? attempts[0].order)).toBe(result.order.id);
  });

  it("H-concurrent. two eligible orphan retries link one order and one reservation", async () => {
    const seeded = await seedCart({ stockCount: 2, quantity: 1 });
    const attemptId = `attempt-orphan-race-${seeded.user.id}`;
    const quote = await createCheckoutQuote(strapi, seeded.user.id, {
      shippingCost: 0,
      gateway: "mellat",
    });
    const orphan = await strapi.db.query("api::payment-attempt.payment-attempt").create({
      data: {
        attemptId,
        quoteHash: quote.quoteHash,
        quoteSnapshot: quote,
        Status: "Created",
        Gateway: "mellat",
        Amount: Math.round(quote.financialSummary.total * 10),
        user: seeded.user.id,
      },
    });
    f.remember("api::payment-attempt.payment-attempt", orphan.id);

    const payload = {
      gateway: "mellat",
      attemptId,
      quoteHash: quote.quoteHash,
      shippingCost: 0,
    };
    const [first, second] = await Promise.all([
      strapi.service("api::cart.cart").finalizeCartToOrder(seeded.user.id, payload),
      strapi.service("api::cart.cart").finalizeCartToOrder(seeded.user.id, payload),
    ]);
    await rememberFinalize(first);
    await rememberFinalize(second);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.errorCode).not.toBe("RESERVATION_EXPIRED");
    expect(second.errorCode).not.toBe("RESERVATION_EXPIRED");
    const orderId = Number(first.order?.id || second.order?.id);
    expect(orderId).toBeGreaterThan(0);
    expect(Number(first.order?.id || orderId)).toBe(orderId);
    expect(Number(second.order?.id || orderId)).toBe(orderId);

    const attempts = await strapi.db.query("api::payment-attempt.payment-attempt").findMany({
      where: { attemptId },
      populate: { order: true },
    });
    expect(attempts).toHaveLength(1);
    expect(Number(attempts[0].order?.id ?? attempts[0].order)).toBe(orderId);

    const orders = await strapi.db.query("api::order.order").findMany({
      where: { user: { id: seeded.user.id } },
    });
    expect(orders).toHaveLength(1);
    expect(String(orders[0].ReservationStatus || orders[0].reservationStatus)).toBe("Reserved");

    const stock = await f.getStock(seeded.variation.stockId);
    expect(stockReserved(stock)).toBe(1);
  });
});
