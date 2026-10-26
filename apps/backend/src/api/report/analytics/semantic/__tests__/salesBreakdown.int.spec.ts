/**
 * Real-Postgres integration test for the sales-breakdown "customer" and "geography"
 * dimensions — the two that depend on join chains (orders -> users, and
 * orders -> delivery_address -> shipping_city -> shipping_province) that had never
 * been exercised by any existing report. See product-analytics.ts resolveJoins()
 * for the verified link-table column names (confirmed against a real Postgres
 * instance, not guessed) and docs/analytics/analytics-decisions.md for the
 * "never silently drop" rule this test enforces for guest/unmapped orders.
 *
 * "category" is also here, because it no longer just reuses those CTEs: it walks
 * `product_categories_parent_links` in a recursive CTE to roll each category's
 * subtree up. That link table's name and column direction, and the distinct order
 * count at every depth, can only be proven against a real Postgres — a mocked
 * spec would happily agree with whatever the code assumed.
 *
 * "status"/"coupon" reuse the already-integration-tested paidOrdersCte/
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
import { canonicalCategorySales } from "../reconciliation";

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
  /** Line items to attach instead of the default single anonymous variation. */
  items?: Array<{ variationId: number; amountToman: number; count?: number }>;
}) {
  const amountToman =
    opts.items?.reduce((sum, i) => sum + i.amountToman * (i.count ?? 1), 0) ??
    opts.amountToman ??
    500_000;
  const variation = opts.items ? null : await f.createVariation({ price: amountToman });
  const contract = await f.createContract({ amount: amountToman, status: "Finished", userId: opts.userId });
  await f.createContractTransaction({
    contractId: contract.id,
    amount: amountToman * 10, // IRR
    status: "Success",
    type: "Gateway",
  });
  const order = await f.createOrder({
    // Eligibility requires the completed status on BOTH paid-orders definitions:
    // settlement alone no longer makes an order count as revenue.
    status: PA.ELIGIBLE_ORDER_STATUS,
    contractId: contract.id,
    userId: opts.userId,
    deliveryAddressId: opts.deliveryAddressId,
  });
  if (opts.items) {
    for (const item of opts.items) {
      await f.createOrderItem({
        orderId: order.id,
        variationId: item.variationId,
        count: item.count ?? 1,
        perAmount: item.amountToman,
      });
    }
  } else {
    await f.createOrderItem({
      orderId: order.id,
      variationId: variation!.id,
      count: 1,
      perAmount: amountToman,
    });
  }
  const knex = strapi.db.connection;
  await knex.raw("UPDATE orders SET date = ? WHERE id = ?", [`${BUCKET_DATE}T09:00:00Z`, order.id]);
  return order;
}

/** A variation whose product's MAIN category is `categoryId`. */
async function variationIn(categoryId: number, price: number) {
  const product = await f.createProduct({ mainCategoryId: categoryId });
  return f.createVariation({ price, productId: product.id });
}

/**
 * A variation whose product is filed under `mainId` as its main category and under
 * `otherIds` through `product_other_categories` — the second membership route, the
 * one category reporting used to ignore.
 */
async function variationInCategories(mainId: number, otherIds: number[], price: number) {
  const product = await f.createProduct({ mainCategoryId: mainId, otherCategoryIds: otherIds });
  return f.createVariation({ price, productId: product.id });
}

describe("sales breakdown: category hierarchy (real Postgres)", () => {
  it("resolves the category parent link from the real schema", async () => {
    const joins = await PA.resolveJoins(strapi.db.connection);
    // Guessed column names would silently produce a flat report, so assert the
    // resolver actually found the self-relation and picked the right direction.
    expect(joins.categoryParentLink).toEqual({
      table: "product_categories_parent_links",
      childCol: "product_category_id",
      parentCol: "inv_product_category_id",
    });
  });

  it("rolls child sales up to the parent and counts a sibling-spanning order once", async () => {
    const knex = strapi.db.connection;
    const parent = await f.createCategory({ title: "دسته والد" });
    const childA = await f.createCategory({ title: "زیرمجموعه الف", parentId: parent.id });
    const childB = await f.createCategory({ title: "زیرمجموعه ب", parentId: parent.id });

    const varA = await variationIn(childA.id, 300_000);
    const varB = await variationIn(childB.id, 200_000);

    // ONE order buying from BOTH siblings. Summing children on the client would
    // report 2 orders for the parent; the SQL rollup must report 1.
    await makeEligibleOrder({
      items: [
        { variationId: varA.id, amountToman: 300_000 },
        { variationId: varB.id, amountToman: 200_000 },
      ],
    });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r]));

    const parentRow = byKey[String(parent.id)];
    expect(parentRow).toBeDefined();
    expect(parentRow.parentKey).toBeNull();
    expect(parentRow.depth).toBe(0);
    expect(parentRow.grossToman).toBe(500_000);
    expect(parentRow.ordersCount).toBe(1);

    expect(byKey[String(childA.id)]).toMatchObject({
      parentKey: String(parent.id),
      depth: 1,
      grossToman: 300_000,
      ordersCount: 1,
    });
    expect(byKey[String(childB.id)]).toMatchObject({
      parentKey: String(parent.id),
      depth: 1,
      grossToman: 200_000,
      ordersCount: 1,
    });

    // Money sums up the tree; distinct order counts deliberately do not.
    expect(byKey[String(childA.id)].grossToman + byKey[String(childB.id)].grossToman).toBe(
      parentRow.grossToman,
    );
    expect(
      byKey[String(childA.id)].ordersCount + byKey[String(childB.id)].ordersCount,
    ).toBeGreaterThan(parentRow.ordersCount);
  });

  it("gives a parent with sales of its own a '(مستقیم)' child so the levels reconcile", async () => {
    const knex = strapi.db.connection;
    const parent = await f.createCategory({ title: "والد فروشنده" });
    const child = await f.createCategory({ title: "زیرمجموعه", parentId: parent.id });

    const parentVar = await variationIn(parent.id, 100_000);
    const childVar = await variationIn(child.id, 400_000);
    await makeEligibleOrder({ items: [{ variationId: parentVar.id, amountToman: 100_000 }] });
    await makeEligibleOrder({ items: [{ variationId: childVar.id, amountToman: 400_000 }] });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r]));

    expect(byKey[String(parent.id)].grossToman).toBe(500_000);
    const self = byKey[`${parent.id}:__self__`];
    expect(self).toBeDefined();
    expect(self.label).toBe("والد فروشنده (مستقیم)");
    expect(self.parentKey).toBe(String(parent.id));
    expect(self.grossToman).toBe(100_000);
    // Expanding the parent now adds up exactly.
    expect(self.grossToman + byKey[String(child.id)].grossToman).toBe(
      byKey[String(parent.id)].grossToman,
    );
  });

  it("keeps a product filed on the parent AND a child out of the '(مستقیم)' row", async () => {
    // The production shape: jeans filed under «شلوار جین» with «شلوار» as an
    // additional category. That sale already shows in the child row, so repeating it
    // in the parent's "(مستقیم)" row made the expanded parent never add up.
    const knex = strapi.db.connection;
    const parent = await f.createCategory({ title: "شلوار آزمایشی" });
    const child = await f.createCategory({ title: "جین آزمایشی", parentId: parent.id });

    const parentOnly = await variationIn(parent.id, 100_000);
    const both = await variationInCategories(child.id, [parent.id], 400_000);
    await makeEligibleOrder({ items: [{ variationId: parentOnly.id, amountToman: 100_000 }] });
    await makeEligibleOrder({ items: [{ variationId: both.id, amountToman: 400_000 }] });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r]));

    expect(byKey[String(parent.id)]).toMatchObject({ grossToman: 500_000, units: 2, ordersCount: 2 });
    expect(byKey[String(child.id)]).toMatchObject({ grossToman: 400_000, units: 1, ordersCount: 1 });
    expect(byKey[`${parent.id}:__self__`]).toMatchObject({ grossToman: 100_000, units: 1, ordersCount: 1 });
    expect(
      byKey[`${parent.id}:__self__`].grossToman + byKey[String(child.id)].grossToman,
    ).toBe(byKey[String(parent.id)].grossToman);
  });

  it("omits the '(مستقیم)' row when every parent-filed product is also in a child", async () => {
    const knex = strapi.db.connection;
    const parent = await f.createCategory({ title: "والد همپوشان" });
    const child = await f.createCategory({ title: "فرزند همپوشان", parentId: parent.id });

    const both = await variationInCategories(child.id, [parent.id], 400_000);
    await makeEligibleOrder({ items: [{ variationId: both.id, amountToman: 400_000 }] });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r]));

    expect(byKey[String(parent.id)]).toMatchObject({ grossToman: 400_000 });
    expect(byKey[`${parent.id}:__self__`]).toBeUndefined();
  });

  it("rolls a three-level tree all the way to the root", async () => {
    const knex = strapi.db.connection;
    const root = await f.createCategory({ title: "ریشه" });
    const mid = await f.createCategory({ title: "میانی", parentId: root.id });
    const leaf = await f.createCategory({ title: "برگ", parentId: mid.id });

    const leafVar = await variationIn(leaf.id, 250_000);
    await makeEligibleOrder({ items: [{ variationId: leafVar.id, amountToman: 250_000 }] });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r]));

    // A category with no products of its own still gets a row, which is the
    // whole point: previously `ریشه` and `میانی` would have been absent.
    expect(byKey[String(root.id)]).toMatchObject({ parentKey: null, depth: 0, grossToman: 250_000 });
    expect(byKey[String(mid.id)]).toMatchObject({
      parentKey: String(root.id),
      depth: 1,
      grossToman: 250_000,
    });
    expect(byKey[String(leaf.id)]).toMatchObject({
      parentKey: String(mid.id),
      depth: 2,
      grossToman: 250_000,
    });
    // Neither ancestor sells anything directly, so neither gets a "(مستقیم)" row.
    expect(result.rows.filter((r) => r.key.endsWith(":__self__"))).toHaveLength(0);
  });

  it("shows a top-level category whose products hang off IT, not off a child", async () => {
    // The common shape: a main category that is sold from directly and has no
    // subcategories at all. It must appear with its own numbers, as a plain leaf
    // row — no chevron, and NO redundant "(مستقیم)" duplicate of itself.
    const knex = strapi.db.connection;
    const solo = await f.createCategory({ title: "بدون زیرمجموعه" });
    const soloVar = await variationIn(solo.id, 180_000);
    await makeEligibleOrder({ items: [{ variationId: soloVar.id, amountToman: 180_000 }] });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r]));

    expect(byKey[String(solo.id)]).toMatchObject({
      label: "بدون زیرمجموعه",
      parentKey: null,
      depth: 0,
      grossToman: 180_000,
      ordersCount: 1,
    });
    expect(byKey[`${solo.id}:__self__`]).toBeUndefined();
    expect(result.rows.filter((r) => r.parentKey === String(solo.id))).toHaveLength(0);
  });

  it("keeps a parent's own sales visible when its children sold nothing this window", async () => {
    // The subcategories exist in the catalogue but had no sales in range, so they
    // produce no rows. The parent must still show its direct sales, and must not
    // sprout a "(مستقیم)" child that would be the only thing under it.
    const knex = strapi.db.connection;
    const parent = await f.createCategory({ title: "والد با فرزند خاموش" });
    await f.createCategory({ title: "فرزند بی‌فروش", parentId: parent.id });
    const parentVar = await variationIn(parent.id, 90_000);
    await makeEligibleOrder({ items: [{ variationId: parentVar.id, amountToman: 90_000 }] });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r]));

    expect(byKey[String(parent.id)]).toMatchObject({
      parentKey: null,
      depth: 0,
      grossToman: 90_000,
    });
    expect(byKey[`${parent.id}:__self__`]).toBeUndefined();
  });

  it("counts a product filed under a category via product_other_categories", async () => {
    // THE under-reporting incident. Membership used to be the main-category link
    // only, so this product's whole revenue was missing from `extra`.
    const knex = strapi.db.connection;
    const main = await f.createCategory({ title: "دسته اصلی" });
    const extra = await f.createCategory({ title: "دسته فرعی" });

    const variation = await variationInCategories(main.id, [extra.id], 250_000);
    await makeEligibleOrder({ items: [{ variationId: variation.id, amountToman: 250_000 }] });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r]));

    // The sale belongs to BOTH categories, in full, in each.
    expect(byKey[String(main.id)]).toMatchObject({ grossToman: 250_000, units: 1, ordersCount: 1 });
    expect(byKey[String(extra.id)]).toMatchObject({ grossToman: 250_000, units: 1, ordersCount: 1 });
  });

  it("counts a line once when its product reaches one category through several paths", async () => {
    // The product's additional category is also its main category's PARENT, so the
    // parent is reachable both by rollup and by direct membership. Its revenue must
    // still be counted once — a naive join would report double.
    const knex = strapi.db.connection;
    const parent = await f.createCategory({ title: "والد" });
    const child = await f.createCategory({ title: "فرزند", parentId: parent.id });

    const variation = await variationInCategories(child.id, [parent.id], 400_000);
    await makeEligibleOrder({ items: [{ variationId: variation.id, amountToman: 400_000 }] });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r]));

    // 400_000 and one unit, not 800_000 and two.
    expect(byKey[String(parent.id)]).toMatchObject({ grossToman: 400_000, units: 1, ordersCount: 1 });
    expect(byKey[String(child.id)]).toMatchObject({ grossToman: 400_000, units: 1, ordersCount: 1 });
  });

  it("counts multi-quantity lines, several variations of one product, and several qualifying lines in one order", async () => {
    const knex = strapi.db.connection;
    const category = await f.createCategory({ title: "دسته چندقلمی" });
    const product = await f.createProduct({ mainCategoryId: category.id });
    const varA = await f.createVariation({ price: 100_000, productId: product.id });
    const varB = await f.createVariation({ price: 50_000, productId: product.id });

    // One order, two variations of the SAME product, one of them quantity 3.
    await makeEligibleOrder({
      items: [
        { variationId: varA.id, amountToman: 100_000, count: 3 },
        { variationId: varB.id, amountToman: 50_000, count: 2 },
      ],
    });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const row = result.rows.find((r) => r.key === String(category.id))!;

    expect(row.grossToman).toBe(3 * 100_000 + 2 * 50_000);
    expect(row.units).toBe(5);
    expect(row.ordersCount).toBe(1);
  });

  it("keeps historical sales of a product that was later unpublished or removed", async () => {
    // Sales history must not depend on a product's CURRENT publication state.
    const knex = strapi.db.connection;
    const category = await f.createCategory({ title: "دسته بایگانی" });
    const variation = await variationIn(category.id, 175_000);
    await makeEligibleOrder({ items: [{ variationId: variation.id, amountToman: 175_000 }] });

    const productId = (
      await knex("product_variations_product_links")
        .where({ product_variation_id: variation.id })
        .first()
    ).product_id;
    await knex("products").where({ id: productId }).update({ status: "Inactive", removed_at: new Date() });
    await knex("product_variations").where({ id: variation.id }).update({ is_published: false });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const row = result.rows.find((r) => r.key === String(category.id));

    expect(row).toBeDefined();
    expect(row!.grossToman).toBe(175_000);
  });

  it("excludes an order that was paid and then cancelled", async () => {
    const knex = strapi.db.connection;
    const category = await f.createCategory({ title: "دسته لغوشده" });
    const variation = await variationIn(category.id, 900_000);
    const order = await makeEligibleOrder({
      items: [{ variationId: variation.id, amountToman: 900_000 }],
    });
    // Settlement stays in place; only the order status changes.
    await knex("orders").where({ id: order.id }).update({ status: "Cancelled" });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);

    expect(result.rows.find((r) => r.key === String(category.id))).toBeUndefined();
  });

  it("keeps sales exactly on the window's start and end instants", async () => {
    const knex = strapi.db.connection;
    const category = await f.createCategory({ title: "دسته مرزی" });
    const first = await variationIn(category.id, 10_000);
    const last = await variationIn(category.id, 20_000);

    const a = await makeEligibleOrder({ items: [{ variationId: first.id, amountToman: 10_000 }] });
    const b = await makeEligibleOrder({ items: [{ variationId: last.id, amountToman: 20_000 }] });
    await knex("orders").where({ id: a.id }).update({ date: RANGE_START });
    await knex("orders").where({ id: b.id }).update({ date: RANGE_END });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const row = result.rows.find((r) => r.key === String(category.id))!;

    // Both boundaries are inclusive; neither order may fall out of the window.
    expect(row.grossToman).toBe(30_000);
    expect(row.ordersCount).toBe(2);
  });

  it("drops sales one millisecond outside the window", async () => {
    const knex = strapi.db.connection;
    const category = await f.createCategory({ title: "دسته خارج بازه" });
    const variation = await variationIn(category.id, 33_000);
    const order = await makeEligibleOrder({
      items: [{ variationId: variation.id, amountToman: 33_000 }],
    });
    await knex("orders")
      .where({ id: order.id })
      .update({ date: new Date(RANGE_END.getTime() + 1) });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);

    expect(result.rows.find((r) => r.key === String(category.id))).toBeUndefined();
  });

  it("pro-rates order-level discount and refund to each category by line share, and nets correctly", async () => {
    const knex = strapi.db.connection;
    const catA = await f.createCategory({ title: "دسته الف" });
    const catB = await f.createCategory({ title: "دسته ب" });
    const varA = await variationIn(catA.id, 750_000);
    const varB = await variationIn(catB.id, 250_000);

    // One order, gross 1,000,000, split 75/25 between two unrelated categories.
    const order = await makeEligibleOrder({
      items: [
        { variationId: varA.id, amountToman: 750_000 },
        { variationId: varB.id, amountToman: 250_000 },
      ],
    });

    // 100,000 Toman order-level discount, and a 200,000 Toman refund recorded in the
    // settlement ledger (which is denominated in IRR, hence x10).
    await knex("orders").where({ id: order.id }).update({ applied_discount_amount: 100_000 });
    const contractId = (
      await knex("orders_contract_links").where({ order_id: order.id }).first()
    ).contract_id;
    await f.createContractTransaction({
      contractId,
      amount: 200_000 * 10,
      status: "Success",
      type: "Return",
    });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r]));

    // Line share drives the split: 75% / 25% of both the discount and the refund.
    expect(byKey[String(catA.id)]).toMatchObject({
      grossToman: 750_000,
      discountsToman: 75_000,
      refundsToman: 150_000,
      netToman: 750_000 - 75_000 - 150_000,
    });
    expect(byKey[String(catB.id)]).toMatchObject({
      grossToman: 250_000,
      discountsToman: 25_000,
      refundsToman: 50_000,
      netToman: 250_000 - 25_000 - 50_000,
    });

    // net = gross - discounts - refunds, and the refund is converted out of IRR once.
    for (const row of [byKey[String(catA.id)], byKey[String(catB.id)]]) {
      expect(row.netToman).toBe(row.grossToman - row.discountsToman - row.refundsToman);
    }

    const canonical = await canonicalCategorySales(knex, joins, catA.id, RANGE_START, RANGE_END);
    expect(byKey[String(catA.id)].netToman).toBe(canonical.netToman);
  });

  it("keeps an uncategorized sale as a root bucket instead of dropping it", async () => {
    const knex = strapi.db.connection;
    await makeEligibleOrder({ amountToman: 120_000 }); // variation with no product
    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const row = result.rows.find((r) => r.key === "");
    expect(row).toBeDefined();
    expect(row!.label).toBe("بدون دسته‌بندی");
    expect(row!.parentKey).toBeNull();
    expect(row!.grossToman).toBe(120_000);
  });
});

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
    // Category is a tree: a parent row already CONTAINS its descendants' totals,
    // so the grand total is the sum of the ROOTS, not of every row. (A row whose
    // parent isn't in the result set counts as a root — same rule the client uses.)
    const categoryKeys = new Set(byCategory.rows.map((r) => r.key));
    const categoryRoots = byCategory.rows.filter(
      (r) => !r.parentKey || !categoryKeys.has(r.parentKey),
    );
    expect(sumNet(categoryRoots)).toBe(statusTotal);
    expect(sumNet(byCoupon.rows)).toBe(statusTotal);
    // customer/geography each go through their own LEFT JOIN chain (users, and
    // delivery_address -> shipping_city -> shipping_province) — if either link table
    // ever carried more than one row per order, COUNT(*)/SUM would double-count and
    // this would diverge from the other three dimensions.
    expect(sumNet(byCustomer.rows)).toBe(statusTotal);
    expect(sumNet(byGeography.rows)).toBe(statusTotal);
  });
});

/**
 * The reconciliation gate: the report's fast, CTE-heavy category query must agree
 * with a slow, obvious `EXISTS`-based re-derivation of the same numbers from the raw
 * link tables. Any future optimisation that quietly changes what a category means
 * fails here.
 */
describe("sales breakdown: category reconciles with the canonical raw query", () => {
  it("agrees with the canonical query on a tree with overlapping membership", async () => {
    const knex = strapi.db.connection;

    const parent = await f.createCategory({ title: "پوشاک" });
    const childA = await f.createCategory({ title: "شال", parentId: parent.id });
    const childB = await f.createCategory({ title: "کلاه", parentId: parent.id });
    const unrelated = await f.createCategory({ title: "بی‌ربط" });

    // Every membership shape at once:
    //  - plain child membership
    //  - a product whose ADDITIONAL category is an unrelated tree
    //  - a product whose ADDITIONAL category is its own main category's parent
    //    (reaches the parent by two paths — must not double count)
    const plain = await variationIn(childA.id, 300_000);
    const crossFiled = await variationInCategories(childB.id, [unrelated.id], 200_000);
    const doublePath = await variationInCategories(childA.id, [parent.id], 150_000);

    // One order spanning two siblings, plus a separate multi-quantity order.
    await makeEligibleOrder({
      items: [
        { variationId: plain.id, amountToman: 300_000 },
        { variationId: crossFiled.id, amountToman: 200_000 },
      ],
    });
    await makeEligibleOrder({ items: [{ variationId: doublePath.id, amountToman: 150_000, count: 2 }] });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r]));

    // Each category's SUBTREE row must equal the canonical recursive figure. The
    // canonical direct figure (filed on this exact category) is checked on leaves only:
    // a parent's "(مستقیم)" row also excludes products filed on a descendant.
    for (const category of [parent, childA, childB, unrelated]) {
      const recursive = await canonicalCategorySales(
        knex, joins, category.id, RANGE_START, RANGE_END, { includeDescendants: true },
      );
      const direct = await canonicalCategorySales(
        knex, joins, category.id, RANGE_START, RANGE_END, { includeDescendants: false },
      );

      const row = byKey[String(category.id)];
      expect(row).toBeDefined();
      expect({
        ordersCount: row.ordersCount,
        units: row.units,
        grossToman: row.grossToman,
        discountsToman: row.discountsToman,
        refundsToman: row.refundsToman,
        netToman: row.netToman,
      }).toEqual(recursive);

      // Leaves have no subtree beyond themselves, so both views coincide there.
      if (category.id === childA.id || category.id === childB.id || category.id === unrelated.id) {
        expect(recursive).toEqual(direct);
      }
    }

    // And the specific thing the incident was about: the parent is NOT the sum of
    // its children, because a product can belong to several categories at once.
    const parentRow = byKey[String(parent.id)];
    expect(parentRow.grossToman).toBe(300_000 + 200_000 + 2 * 150_000);
    expect(parentRow.ordersCount).toBe(2);
  });

  it("agrees with the canonical query for a category whose products are all filed under it indirectly", async () => {
    const knex = strapi.db.connection;
    const primary = await f.createCategory({ title: "اصلی" });
    const secondary = await f.createCategory({ title: "فرعی" });

    const variation = await variationInCategories(primary.id, [secondary.id], 500_000);
    await makeEligibleOrder({ items: [{ variationId: variation.id, amountToman: 500_000 }] });

    const joins = await PA.resolveJoins(knex);
    const result = await getSalesBreakdown(knex, joins, "category", RANGE_START, RANGE_END);
    const row = result.rows.find((r) => r.key === String(secondary.id));

    const canonical = await canonicalCategorySales(
      knex, joins, secondary.id, RANGE_START, RANGE_END,
    );

    expect(canonical.grossToman).toBe(500_000);
    expect(row).toBeDefined();
    expect(row!.grossToman).toBe(canonical.grossToman);
    expect(row!.ordersCount).toBe(canonical.ordersCount);
    expect(row!.units).toBe(canonical.units);
    expect(row!.netToman).toBe(canonical.netToman);
  });
});
