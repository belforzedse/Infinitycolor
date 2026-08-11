/**
 * Tier 1 integration suite — post-payment cart cleanup consumes the checkout snapshot.
 *
 * Runs against a REAL Strapi + REAL Postgres. The idempotency marker is a guarded
 * `UPDATE orders SET cart_cleanup_completed_at = ? WHERE ... IS NULL RETURNING id`
 * committed together with the cart mutations, so both halves need a real transaction to
 * mean anything.
 */
import {
  consumeCheckoutCartLines,
  consumeCheckoutCartLinesSafely,
} from "../../../api/cart/services/lib/order-cart-cleanup";
import { runReconcileCartCleanupTick } from "../../../jobs/reconcileCartCleanup";
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
  jest.restoreAllMocks();
  await f.cleanup();
});

/**
 * Builds the post-checkout shape: a paid order whose items record the cart lines they
 * were created from, plus the customer's live cart.
 */
async function createPaidCheckout(opts: { purchasedCount?: number; cartCount?: number } = {}) {
  const purchasedCount = opts.purchasedCount ?? 1;
  const cartCount = opts.cartCount ?? purchasedCount;

  const user = await f.createUser();
  const cart = await f.createCart({ userId: user.id });
  const unitPrice = 1000;
  const variation = await f.createVariation({ stockCount: 10, price: unitPrice });
  const cartItem = await f.createCartItem({
    cartId: cart.id,
    variationId: variation.id,
    count: cartCount,
    price: unitPrice,
  });
  const order = await f.createOrder({ status: "Started", userId: user.id });
  await f.createOrderItem({
    orderId: order.id,
    variationId: variation.id,
    count: purchasedCount,
    sourceCartItemId: cartItem.id,
  });

  return { user, cart, variation, cartItem, order, unitPrice };
}

describe("consumeCheckoutCartLines", () => {
  it("leaves an item added while the customer was at the gateway", async () => {
    const { cart, order, cartItem } = await createPaidCheckout();
    const otherVariation = await f.createVariation({ stockCount: 10 });
    const addedLater = await f.createCartItem({
      cartId: cart.id,
      variationId: otherVariation.id,
      count: 2,
      price: 1000,
    });

    await consumeCheckoutCartLines(strapi, order.id);

    const remaining = await f.getCartItems(cart.id);
    expect(remaining.map((item: any) => item.id)).toEqual([addedLater.id]);
    expect(await f.getCartItem(cartItem.id)).toBeNull();
  });

  it("consumes only the historical quantity when the source line was increased", async () => {
    // Checkout consumed A x1; the customer then raised that same line to x3.
    const { cart, order, cartItem } = await createPaidCheckout({
      purchasedCount: 1,
      cartCount: 3,
    });

    await consumeCheckoutCartLines(strapi, order.id);

    const remaining = await f.getCartItem(cartItem.id);
    expect(Number(remaining.Count)).toBe(2);
    // Sum is recomputed from the variation's price, matching how addCartItem and
    // mergeGuestCart maintain it.
    expect(Number(remaining.Sum)).toBe(2000);
    expect((await f.getCartItems(cart.id))).toHaveLength(1);
  });

  it("does not touch a re-added line for the same SKU", async () => {
    const { cart, order, cartItem, variation } = await createPaidCheckout();

    // The customer deletes the source line and re-adds the same product.
    await strapi.db.query("api::cart-item.cart-item").delete({ where: { id: cartItem.id } });
    const reAdded = await f.createCartItem({
      cartId: cart.id,
      variationId: variation.id,
      count: 1,
      price: 1000,
    });

    await consumeCheckoutCartLines(strapi, order.id);

    const remaining = await f.getCartItems(cart.id);
    expect(remaining.map((item: any) => item.id)).toEqual([reAdded.id]);
    expect(Number(remaining[0].Count)).toBe(1);
  });

  it("isolates overlapping checkouts to their own source lines", async () => {
    const user = await f.createUser();
    const cart = await f.createCart({ userId: user.id });
    const variationA = await f.createVariation({ stockCount: 10 });
    const variationB = await f.createVariation({ stockCount: 10 });
    const lineA = await f.createCartItem({ cartId: cart.id, variationId: variationA.id, count: 1 });
    const lineB = await f.createCartItem({ cartId: cart.id, variationId: variationB.id, count: 1 });

    const orderA = await f.createOrder({ status: "Started", userId: user.id });
    await f.createOrderItem({
      orderId: orderA.id,
      variationId: variationA.id,
      count: 1,
      sourceCartItemId: lineA.id,
    });
    const orderB = await f.createOrder({ status: "Started", userId: user.id });
    await f.createOrderItem({
      orderId: orderB.id,
      variationId: variationB.id,
      count: 1,
      sourceCartItemId: lineB.id,
    });

    await consumeCheckoutCartLines(strapi, orderA.id);
    expect((await f.getCartItems(cart.id)).map((item: any) => item.id)).toEqual([lineB.id]);

    await consumeCheckoutCartLines(strapi, orderB.id);
    expect(await f.getCartItems(cart.id)).toHaveLength(0);
  });

  it("is idempotent: repeating cleanup consumes nothing more", async () => {
    const { order, cartItem } = await createPaidCheckout({ purchasedCount: 1, cartCount: 3 });

    await consumeCheckoutCartLines(strapi, order.id);
    const second = await consumeCheckoutCartLines(strapi, order.id);

    expect(second.status).toBe("already_applied");
    expect(Number((await f.getCartItem(cartItem.id)).Count)).toBe(2);
  });

  it("consumes once when two callbacks race", async () => {
    const { order, cartItem } = await createPaidCheckout({ purchasedCount: 1, cartCount: 3 });

    const outcomes = await Promise.all([
      consumeCheckoutCartLines(strapi, order.id),
      consumeCheckoutCartLines(strapi, order.id),
    ]);

    expect(outcomes.filter((o) => o.status === "applied")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "already_applied")).toHaveLength(1);
    expect(Number((await f.getCartItem(cartItem.id)).Count)).toBe(2);
  });

  it("empties the cart status only when nothing remains", async () => {
    const { cart, order } = await createPaidCheckout();

    await consumeCheckoutCartLines(strapi, order.id);

    expect((await f.getCart(cart.id)).Status).toBe("Empty");
  });

  it("never reaches into another customer's cart", async () => {
    const otherUser = await f.createUser();
    const otherCart = await f.createCart({ userId: otherUser.id });
    const variation = await f.createVariation({ stockCount: 10 });
    const otherLine = await f.createCartItem({
      cartId: otherCart.id,
      variationId: variation.id,
      count: 2,
    });

    const buyer = await f.createUser();
    const order = await f.createOrder({ status: "Started", userId: buyer.id });
    await f.createOrderItem({
      orderId: order.id,
      variationId: variation.id,
      count: 1,
      // A stale/foreign source id must not authorize a write.
      sourceCartItemId: otherLine.id,
    });

    await consumeCheckoutCartLines(strapi, order.id);

    expect(Number((await f.getCartItem(otherLine.id)).Count)).toBe(2);
  });

  it("marks pre-migration orders complete without touching the cart", async () => {
    const user = await f.createUser();
    const cart = await f.createCart({ userId: user.id });
    const variation = await f.createVariation({ stockCount: 10 });
    const line = await f.createCartItem({ cartId: cart.id, variationId: variation.id, count: 1 });
    const order = await f.createOrder({ status: "Started", userId: user.id });
    // No SourceCartItemId: an order created before the column existed.
    await f.createOrderItem({ orderId: order.id, variationId: variation.id, count: 1 });

    const outcome = await consumeCheckoutCartLines(strapi, order.id);

    expect(outcome.status).toBe("nothing_to_consume");
    expect(Number((await f.getCartItem(line.id)).Count)).toBe(1);
  });
});

describe("cleanup failure stays retryable", () => {
  it("leaves the payment successful and the work durably pending", async () => {
    const { order, cartItem } = await createPaidCheckout();

    jest
      .spyOn(strapi.db.query("api::cart-item.cart-item"), "delete")
      .mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      consumeCheckoutCartLinesSafely(strapi, order.id, { gateway: "SamanKish" }),
    ).resolves.toBe(false);

    // Payment is untouched, the cart line is intact, and the marker is still NULL — which
    // is exactly what the reconcile sweep looks for.
    const failedOrder = await f.getOrder(order.id);
    expect(failedOrder.Status).toBe("Started");
    expect(failedOrder.CartCleanupCompletedAt).toBeNull();
    expect(Number((await f.getCartItem(cartItem.id)).Count)).toBe(1);

    // The failure is durably visible, not just logged.
    const logs = await f.getOrderLogs(order.id);
    expect(logs.some((log: any) => /Cart cleanup failed/.test(String(log.Description)))).toBe(true);
  });

  it("is completed by the reconciliation sweep, and a second tick changes nothing", async () => {
    const { order, cartItem } = await createPaidCheckout();

    jest
      .spyOn(strapi.db.query("api::cart-item.cart-item"), "delete")
      .mockRejectedValueOnce(new Error("connection reset"));
    await consumeCheckoutCartLinesSafely(strapi, order.id, { gateway: "SamanKish" });
    jest.restoreAllMocks();

    const first = await runReconcileCartCleanupTick(strapi, { graceSeconds: 0 });
    expect(first.status).toBe("completed");
    expect(Number(first.stats.processed)).toBeGreaterThanOrEqual(1);

    expect(await f.getCartItem(cartItem.id)).toBeNull();
    expect((await f.getOrder(order.id)).CartCleanupCompletedAt).not.toBeNull();

    const second = await runReconcileCartCleanupTick(strapi, { graceSeconds: 0 });
    expect(Number(second.stats.processed)).toBe(0);
  });

  it("ignores orders that are still unpaid", async () => {
    const user = await f.createUser();
    const cart = await f.createCart({ userId: user.id });
    const variation = await f.createVariation({ stockCount: 10 });
    const line = await f.createCartItem({ cartId: cart.id, variationId: variation.id, count: 1 });
    const order = await f.createOrder({ status: "Paying", userId: user.id });
    await f.createOrderItem({
      orderId: order.id,
      variationId: variation.id,
      count: 1,
      sourceCartItemId: line.id,
    });

    await runReconcileCartCleanupTick(strapi, { graceSeconds: 0 });

    expect(Number((await f.getCartItem(line.id)).Count)).toBe(1);
    expect((await f.getOrder(order.id)).CartCleanupCompletedAt).toBeNull();
  });
});
