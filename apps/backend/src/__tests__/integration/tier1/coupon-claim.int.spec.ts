/**
 * Tier 1 integration suite — limited-coupon usage claiming.
 *
 * Runs against a REAL Strapi + REAL Postgres. The whole point of this fix is a guarded
 * `UPDATE ... WHERE used_times < limit_usage RETURNING ...`, whose concurrency behavior
 * only exists on a real engine: a mocked query builder would happily let both racers
 * "win". Nothing here stubs the statement under test.
 */
import {
  claimLimitedDiscountUsage,
  releaseOrderDiscountClaim,
} from "../../../api/cart/services/lib/discount-claim";
import { releaseOrderReservation } from "../../../utils/stockReservations";
import { runExpireStockReservationsTick } from "../../../jobs/expireStockReservations";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

let strapi: any;
let f: Factories;

const minutes = (n: number) => n * 60 * 1000;

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

/** Runs one claim in its own transaction, the way finalizeCartToOrder does. */
const claimInTransaction = (orderId: number, code: string) =>
  strapi.db.transaction(async ({ trx }: any) =>
    claimLimitedDiscountUsage(strapi, { orderId, code, trx }),
  );

describe("limited coupon claiming", () => {
  it("claims one usage and records it on the order", async () => {
    const discount = await f.createDiscount({ limitUsage: 5, usedTimes: 0 });
    const order = await f.createOrder({ discountCode: discount.Code });

    const result = await claimInTransaction(order.id, discount.Code);

    expect(result.claimed).toBe(true);
    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(1);
    expect(Number((await f.getOrder(order.id)).DiscountUsageClaimedDiscountId)).toBe(discount.id);
  });

  it("refuses an already exhausted coupon", async () => {
    const discount = await f.createDiscount({ limitUsage: 10, usedTimes: 10 });
    const order = await f.createOrder({ discountCode: discount.Code });

    await expect(claimInTransaction(order.id, discount.Code)).rejects.toThrow(
      "DISCOUNT_USAGE_EXHAUSTED",
    );

    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(10);
    expect((await f.getOrder(order.id)).DiscountUsageClaimedDiscountId).toBeNull();
  });

  it("leaves unlimited coupons to the settlement-time counter", async () => {
    const discount = await f.createDiscount({ limitUsage: 0, usedTimes: 3 });
    const order = await f.createOrder({ discountCode: discount.Code });

    const result = await claimInTransaction(order.id, discount.Code);

    expect(result.claimed).toBe(false);
    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(3);
    expect((await f.getOrder(order.id)).DiscountUsageClaimedDiscountId).toBeNull();
  });

  it("has exactly one winner when two checkouts race for the last usage", async () => {
    const discount = await f.createDiscount({ limitUsage: 1, usedTimes: 0 });
    const orderA = await f.createOrder({ discountCode: discount.Code });
    const orderB = await f.createOrder({ discountCode: discount.Code });

    const results = await Promise.allSettled([
      claimInTransaction(orderA.id, discount.Code),
      claimInTransaction(orderB.id, discount.Code),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain(
      "DISCOUNT_USAGE_EXHAUSTED",
    );

    // The cap holds: exactly one usage consumed, held by exactly one order.
    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(1);
    const claims = [
      (await f.getOrder(orderA.id)).DiscountUsageClaimedDiscountId,
      (await f.getOrder(orderB.id)).DiscountUsageClaimedDiscountId,
    ].filter((value) => value !== null);
    expect(claims).toHaveLength(1);
  });

  it("never exceeds the cap under heavier contention", async () => {
    const discount = await f.createDiscount({ limitUsage: 3, usedTimes: 0 });
    const orders = await Promise.all(
      Array.from({ length: 8 }, () => f.createOrder({ discountCode: discount.Code })),
    );

    const results = await Promise.allSettled(
      orders.map((order) => claimInTransaction(order.id, discount.Code)),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(3);
  });

  it("rolls the claim back when the surrounding checkout transaction fails", async () => {
    const discount = await f.createDiscount({ limitUsage: 1, usedTimes: 0 });
    const order = await f.createOrder({ discountCode: discount.Code });

    await expect(
      strapi.db.transaction(async ({ trx }: any) => {
        await claimLimitedDiscountUsage(strapi, { orderId: order.id, code: discount.Code, trx });
        // Anything later in checkout can fail — contract creation, stock reservation,
        // the payment attempt insert. The usage must not be burned by a checkout that
        // never became durable.
        throw new Error("CONTRACT_CREATION_FAILED: injected");
      }),
    ).rejects.toThrow("CONTRACT_CREATION_FAILED");

    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(0);
    expect((await f.getOrder(order.id)).DiscountUsageClaimedDiscountId).toBeNull();

    // And the freed usage is genuinely available again.
    const other = await f.createOrder({ discountCode: discount.Code });
    await expect(claimInTransaction(other.id, discount.Code)).resolves.toMatchObject({
      claimed: true,
    });
    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(1);
  });
});

describe("limited coupon release", () => {
  it("releases once and is idempotent on repeat", async () => {
    const discount = await f.createDiscount({ limitUsage: 1, usedTimes: 0 });
    const order = await f.createOrder({ discountCode: discount.Code });
    await claimInTransaction(order.id, discount.Code);

    const first = await strapi.db.transaction(async ({ trx }: any) =>
      releaseOrderDiscountClaim(strapi, order.id, trx),
    );
    const second = await strapi.db.transaction(async ({ trx }: any) =>
      releaseOrderDiscountClaim(strapi, order.id, trx),
    );

    expect(first.released).toBe(true);
    expect(second.released).toBe(false);
    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(0);
  });

  it("cannot be released by two competing failure paths", async () => {
    const discount = await f.createDiscount({ limitUsage: 2, usedTimes: 0 });
    const order = await f.createOrder({ discountCode: discount.Code });
    await claimInTransaction(order.id, discount.Code);
    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(1);

    const results = await Promise.all([
      strapi.db.transaction(async ({ trx }: any) =>
        releaseOrderDiscountClaim(strapi, order.id, trx),
      ),
      strapi.db.transaction(async ({ trx }: any) =>
        releaseOrderDiscountClaim(strapi, order.id, trx),
      ),
    ]);

    expect(results.filter((r) => r.released)).toHaveLength(1);
    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(0);
  });

  it("refuses to release once the order has been paid", async () => {
    const discount = await f.createDiscount({ limitUsage: 1, usedTimes: 0 });
    const order = await f.createOrder({ discountCode: discount.Code });
    await claimInTransaction(order.id, discount.Code);

    // A stale failure callback arriving after settlement must not hand the usage back.
    await strapi.db.query("api::order.order").update({
      where: { id: order.id },
      data: { Status: "Started" },
    });

    const result = await strapi.db.transaction(async ({ trx }: any) =>
      releaseOrderDiscountClaim(strapi, order.id, trx),
    );

    expect(result.released).toBe(false);
    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(1);
    expect(Number((await f.getOrder(order.id)).DiscountUsageClaimedDiscountId)).toBe(discount.id);
  });

  it("frees the usage for another checkout when a reservation is released", async () => {
    const discount = await f.createDiscount({ limitUsage: 1, usedTimes: 0 });
    const { order } = await f.createReservedOrder({
      items: [{ count: 1, stockCount: 5, stockReserved: 1 }],
    });
    await strapi.db.query("api::order.order").update({
      where: { id: order.id },
      data: { DiscountCode: discount.Code },
    });
    await claimInTransaction(order.id, discount.Code);
    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(1);

    // The existing cancellation choke point returns both holds together.
    await releaseOrderReservation(strapi, order.id, "Released");

    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(0);
    const next = await f.createOrder({ discountCode: discount.Code });
    await expect(claimInTransaction(next.id, discount.Code)).resolves.toMatchObject({
      claimed: true,
    });
  });
});

describe("abandoned checkout", () => {
  it("returns the coupon usage through the existing expiry job", async () => {
    const discount = await f.createDiscount({ limitUsage: 1, usedTimes: 0 });
    const { order } = await f.createReservedOrder({
      items: [{ count: 1, stockCount: 5, stockReserved: 1 }],
      reservedUntil: new Date(Date.now() - minutes(30)),
    });
    await strapi.db.query("api::order.order").update({
      where: { id: order.id },
      data: { DiscountCode: discount.Code },
    });
    await claimInTransaction(order.id, discount.Code);

    await runExpireStockReservationsTick(strapi, { now: new Date(), graceSeconds: 0 });

    expect((await f.getOrder(order.id)).Status).toBe("Cancelled");
    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(0);

    // A second tick must not decrement again.
    await runExpireStockReservationsTick(strapi, { now: new Date(), graceSeconds: 0 });
    expect(Number((await f.getDiscount(discount.id)).UsedTimes)).toBe(0);
  });
});
