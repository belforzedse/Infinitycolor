/**
 * Real-Postgres integration test for the sales-breakdown "customer" and "geography"
 * dimensions — the two that depend on join chains (orders -> users, and
 * orders -> delivery_address -> shipping_city -> shipping_province) that had never
 * been exercised by any existing report. See product-analytics.ts resolveJoins()
 * for the verified link-table column names (confirmed against a real Postgres
 * instance, not guessed) and docs/analytics/analytics-decisions.md for the
 * "never silently drop" rule this test enforces for guest/unmapped orders.
 *
 * "status"/"category"/"coupon" reuse the already-integration-tested paidOrdersCte/
 * itemizedCte and are covered by the mocked unit spec (salesBreakdown.spec.ts).
 *
 * Orders are pinned to a fixed historical day (not "now") so this test's broad
 * date-range queries can never pick up unrelated data from other integration spec
 * files sharing the same disposable Postgres instance (maxWorkers: 1).
 */
import { setupStrapi, teardownStrapi } from "../../../../../__tests__/integration/strapiInstance";
import { makeFactories, type Factories } from "../../../../../__tests__/integration/factories";
import * as PA from "../../../services/product-analytics";
import { getSalesBreakdown } from "../salesBreakdown";

let strapi: any;
let f: Factories;

const BUCKET_DATE = "2026-04-10";
const RANGE_START = new Date(`${BUCKET_DATE}T00:00:00Z`);
const RANGE_END = new Date(`${BUCKET_DATE}T23:59:59Z`);

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterAll(async () => {
  await teardownStrapi();
});

beforeEach(() => {
  f = makeFactories(strapi);
  PA.__resetJoinCache();
});

afterEach(async () => {
  await f.cleanup();
});

async function makeEligibleOrder(opts: {
  userId?: number;
  deliveryAddressId?: number;
  amountToman?: number;
}) {
  const amountToman = opts.amountToman ?? 500_000;
  const variation = await f.createVariation({ price: amountToman });
  const contract = await f.createContract({ amount: amountToman, status: "Finished", userId: opts.userId });
  await f.createContractTransaction({
    contractId: contract.id,
    amount: amountToman * 10, // IRR
    status: "Success",
    type: "Gateway",
  });
  const order = await f.createOrder({
    status: "Started",
    contractId: contract.id,
    userId: opts.userId,
    deliveryAddressId: opts.deliveryAddressId,
  });
  await f.createOrderItem({ orderId: order.id, variationId: variation.id, count: 1, perAmount: amountToman });
  const knex = strapi.db.connection;
  await knex.raw("UPDATE orders SET date = ? WHERE id = ?", [`${BUCKET_DATE}T09:00:00Z`, order.id]);
  return order;
}

describe("sales breakdown: customer + geography (real Postgres)", () => {
  it("customer: attributes an order to its user, with a display name from local_user_info", async () => {
    const knex = strapi.db.connection;
    const user = await f.createUser();
    await f.createUserInfo({ userId: user.id, firstName: "علی", lastName: "رضایی" });
    await makeEligibleOrder({ userId: user.id, amountToman: 400_000 });
    const joins = await PA.resolveJoins(knex);

    expect(joins.orderToUser).not.toBe("");

    const result = await getSalesBreakdown(knex, joins, "customer", RANGE_START, RANGE_END);
    const row = result.rows.find((r) => r.key === String(user.id));
    expect(row).toBeDefined();
    expect(row!.label).toBe("علی رضایی");
    expect(row!.grossToman).toBe(400_000);
  });

  it("customer: an order with no user buckets under the explicit guest key ('0'), not dropped", async () => {
    const knex = strapi.db.connection;
    await makeEligibleOrder({ amountToman: 150_000 });
    const joins = await PA.resolveJoins(knex);

    const result = await getSalesBreakdown(knex, joins, "customer", RANGE_START, RANGE_END);
    const guestRow = result.rows.find((r) => r.key === "0");
    expect(guestRow).toBeDefined();
    expect(guestRow!.label).toBe("مهمان");
    expect(guestRow!.grossToman).toBe(150_000);
  });

  it("geography: attributes an order to its delivery address's province", async () => {
    const knex = strapi.db.connection;
    const user = await f.createUser();
    const province = await f.createShippingProvince({ title: "تهران" });
    const city = await f.createShippingCity({ title: "تهران", provinceId: province.id });
    const address = await f.createAddress({ userId: user.id, cityId: city.id });
    await makeEligibleOrder({ userId: user.id, deliveryAddressId: address.id, amountToman: 600_000 });
    const joins = await PA.resolveJoins(knex);

    expect(joins.orderToAddress).not.toBe("");
    expect(joins.addressToCity).not.toBe("");
    expect(joins.cityToProvince).not.toBe("");

    const result = await getSalesBreakdown(knex, joins, "geography", RANGE_START, RANGE_END);
    const row = result.rows.find((r) => r.key === "تهران");
    expect(row).toBeDefined();
    expect(row!.grossToman).toBe(600_000);
  });

  it("geography: an order with no delivery address buckets under 'نامشخص' (unmapped), not dropped", async () => {
    const knex = strapi.db.connection;
    await makeEligibleOrder({ amountToman: 250_000 });
    const joins = await PA.resolveJoins(knex);

    const result = await getSalesBreakdown(knex, joins, "geography", RANGE_START, RANGE_END);
    const unmapped = result.rows.find((r) => r.key === "");
    expect(unmapped).toBeDefined();
    expect(unmapped!.label).toBe("نامشخص");
    expect(unmapped!.grossToman).toBe(250_000);
  });

  it("all 5 dimensions agree on the grand total for the same window (single source of truth)", async () => {
    const knex = strapi.db.connection;
    const user = await f.createUser();
    await makeEligibleOrder({ userId: user.id, amountToman: 300_000 });
    await makeEligibleOrder({ amountToman: 200_000 }); // guest, no delivery address
    const joins = await PA.resolveJoins(knex);

    const [byStatus, byCategory, byCoupon, byCustomer, byGeography] = await Promise.all([
      getSalesBreakdown(knex, joins, "status", RANGE_START, RANGE_END),
      getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END),
      getSalesBreakdown(knex, joins, "coupon", RANGE_START, RANGE_END),
      getSalesBreakdown(knex, joins, "customer", RANGE_START, RANGE_END),
      getSalesBreakdown(knex, joins, "geography", RANGE_START, RANGE_END),
    ]);

    const sumNet = (rows: { netToman: number }[]) => rows.reduce((s, r) => s + r.netToman, 0);
    const statusTotal = sumNet(byStatus.rows);

    expect(statusTotal).toBe(500_000);
    expect(sumNet(byCategory.rows)).toBe(statusTotal);
    expect(sumNet(byCoupon.rows)).toBe(statusTotal);
    // customer/geography each go through their own LEFT JOIN chain (users, and
    // delivery_address -> shipping_city -> shipping_province) — if either link table
    // ever carried more than one row per order, COUNT(*)/SUM would double-count and
    // this would diverge from the other three dimensions.
    expect(sumNet(byCustomer.rows)).toBe(statusTotal);
    expect(sumNet(byGeography.rows)).toBe(statusTotal);
  });
});
