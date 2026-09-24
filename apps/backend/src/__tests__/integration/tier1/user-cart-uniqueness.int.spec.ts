/**
 * Tier 1 integration suite — one cart per customer, under real concurrency.
 *
 * Production (2026-09-17 onward): right after login the storefront fires the guest
 * merge and several cart reads in the same tick. `getOrCreateUserCart` was a plain
 * find-then-create, and Strapi's oneToOne create deletes the user's other link before
 * inserting its own. Overlapping requests therefore left a customer with two linked
 * carts (checkout read either one), or silently unlinked the cart the merge had just
 * filled. Both shapes are asserted here: exactly one link per user, and no cart created
 * during the test left without an owner.
 *
 * Runs against a REAL Strapi + REAL Postgres; nothing about the database is mocked.
 */
import { mergeGuestCart } from "../../../api/cart/services/ops/mergeGuestCart";
import {
  CART_ONE_PER_USER_INDEX,
  ensureCartDatabaseInvariants,
} from "../../../api/cart/services/lib/cart-database";
import { repairUserCarts } from "../../../api/cart/services/lib/cart-repair";
import { consumeCheckoutCartLines } from "../../../api/cart/services/lib/order-cart-cleanup";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Pool } = require("pg");

let strapi: any;
let f: Factories;
let cartIdFloor = 0;

const CONCURRENCY = 25;

const rows = async (sql: string, bindings: unknown[] = []) =>
  (await strapi.db.connection.raw(sql, bindings)).rows as any[];

const linkedCartIds = async (userId: number): Promise<number[]> =>
  (
    await rows(`SELECT cart_id FROM carts_user_links WHERE user_id = ? ORDER BY cart_id`, [userId])
  ).map((row) => Number(row.cart_id));

/** Carts created since the test started that no user owns: the "stolen link" race. */
const orphanCartIdsSinceStart = async (): Promise<number[]> =>
  (
    await rows(
      `SELECT c.id FROM carts c
        WHERE c.id > ?
          AND NOT EXISTS (SELECT 1 FROM carts_user_links l WHERE l.cart_id = c.id)
        ORDER BY c.id`,
      [cartIdFloor],
    )
  ).map((row) => Number(row.id));

const cartLines = async (cartId: number) =>
  (
    await rows(
      `SELECT ci.id, ci.count, pv.product_variation_id AS variation_id
         FROM cart_items_cart_links il
         JOIN cart_items ci ON ci.id = il.cart_item_id
         LEFT JOIN cart_items_product_variation_links pv ON pv.cart_item_id = ci.id
        WHERE il.cart_id = ?
        ORDER BY pv.product_variation_id`,
      [cartId],
    )
  ).map((row) => ({
    id: Number(row.id),
    count: Number(row.count),
    variationId: Number(row.variation_id),
  }));

/** Tracks every cart row this test produced so cleanup() removes them. */
const rememberCartsSinceStart = async () => {
  const created = await rows(`SELECT id FROM carts WHERE id > ?`, [cartIdFloor]);
  for (const row of created) f.remember("api::cart.cart", Number(row.id));
};

const cartService = () => strapi.service("api::cart.cart");

const indexExists = async () =>
  (await rows(`SELECT 1 FROM pg_class WHERE relname = ? AND relkind = 'i'`, [CART_ONE_PER_USER_INDEX]))
    .length === 1;

const dropCartIndex = async () => {
  await strapi.db.connection.raw(`DROP INDEX IF EXISTS ${CART_ONE_PER_USER_INDEX}`);
};

const variationCounts = (cart: any) =>
  Object.fromEntries(
    (cart.cart_items || []).map((item: any) => [item.product_variation.id, item.Count]),
  );

/** Settles a promise against a timer: "pending" if it has not finished in `ms`. */
const within = async <T>(promise: Promise<T>, ms: number): Promise<T | "pending"> =>
  Promise.race([promise, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms))]);

/** A variation the cart code accepts: published, stocked, on an Active product. */
const sellableVariation = async (opts: { price?: number; stockCount?: number } = {}) => {
  const product = await f.createProduct({ status: "Active" });
  return f.createVariation({
    productId: product.id,
    price: opts.price ?? 1000,
    stockCount: opts.stockCount ?? 10,
  });
};

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterAll(async () => {
  // Whatever a test did to the index, leave the database with the invariant in place.
  await ensureCartDatabaseInvariants(strapi);
  await teardownStrapi();
});

beforeEach(async () => {
  f = makeFactories(strapi);
  const [{ max }] = await rows(`SELECT COALESCE(MAX(id), 0) AS max FROM carts`);
  cartIdFloor = Number(max);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await rememberCartsSinceStart();
  await f.cleanup();
});

describe("concurrent get-or-create", () => {
  it("resolves every concurrent caller to one cart and leaves no second or orphaned cart", async () => {
    const user = await f.createUser();

    const carts = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => cartService().getUserCart(user.id)),
    );

    const linked = await linkedCartIds(user.id);
    expect({ linked, orphaned: await orphanCartIdsSinceStart() }).toEqual({
      linked: [expect.any(Number)],
      orphaned: [],
    });
    expect(new Set(carts.map((cart: any) => cart.id))).toEqual(new Set(linked));
  });
});

describe("guest cart → login", () => {
  it("keeps the merged guest items in the one cart every post-login request resolves", async () => {
    const user = await f.createUser();
    const first = await sellableVariation({ price: 1000 });
    const second = await sellableVariation({ price: 2000 });

    // The storefront's post-login burst: the merge, plus the cart reads Bill and
    // CartProvider issue while it runs.
    const [merge, ...reads] = await Promise.all([
      mergeGuestCart(strapi, user.id, `merge-${user.id}-a`, [
        { productVariationId: first.id, quantity: 2 },
        { productVariationId: second.id, quantity: 1 },
      ]),
      ...Array.from({ length: 10 }, () => cartService().getUserCart(user.id)),
      cartService().checkCartStock(user.id),
      cartService().checkCartStock(user.id),
    ]);

    expect(merge.accepted).toHaveLength(2);
    const linked = await linkedCartIds(user.id);
    expect({ linked, orphaned: await orphanCartIdsSinceStart() }).toEqual({
      linked: [expect.any(Number)],
      orphaned: [],
    });

    const readCartIds = reads.map((result: any) => result?.cart?.id ?? result?.id);
    expect(new Set(readCartIds.filter(Boolean))).toEqual(new Set(linked));

    const settled = await cartService().getUserCart(user.id);
    expect(settled.id).toBe(linked[0]);
    expect(
      (settled.cart_items || [])
        .map((item: any) => [item.product_variation.id, item.Count])
        .sort((a: number[], b: number[]) => a[0] - b[0]),
    ).toEqual(
      [
        [first.id, 2],
        [second.id, 1],
      ].sort((a, b) => a[0] - b[0]),
    );
    expect(await cartLines(linked[0])).toHaveLength(2);
  });
});

describe("before the uniqueness index exists (the rollout window)", () => {
  afterEach(async () => {
    expect(await ensureCartDatabaseInvariants(strapi)).toMatch(/installed|present/);
  });

  it("still converges every concurrent caller and the merge on one cart through the per-user lock", async () => {
    await dropCartIndex();
    expect(await indexExists()).toBe(false);
    const user = await f.createUser();
    const variation = await sellableVariation();

    const [merge, ...carts] = await Promise.all([
      mergeGuestCart(strapi, user.id, `merge-${user.id}-window`, [
        { productVariationId: variation.id, quantity: 1 },
      ]),
      ...Array.from({ length: CONCURRENCY }, () => cartService().getUserCart(user.id)),
    ]);

    expect(merge.accepted).toHaveLength(1);
    const linked = await linkedCartIds(user.id);
    expect({ linked, orphaned: await orphanCartIdsSinceStart() }).toEqual({
      linked: [expect.any(Number)],
      orphaned: [],
    });
    expect(new Set(carts.map((cart: any) => cart.id))).toEqual(new Set(linked));
    expect(variationCounts(await cartService().getUserCart(user.id))).toEqual({ [variation.id]: 1 });
  });
});

describe("existing customer cart + guest cart", () => {
  it("adds the guest lines to the customer's cart with the existing merge rules", async () => {
    const user = await f.createUser();
    const shared = await sellableVariation({ stockCount: 10 });
    const guestOnly = await sellableVariation({ stockCount: 10 });
    const cart = await cartService().getUserCart(user.id);
    await cartService().addCartItem(cart.id, shared.id, 1);

    await Promise.all([
      mergeGuestCart(strapi, user.id, `merge-${user.id}-existing`, [
        { productVariationId: shared.id, quantity: 2 },
        { productVariationId: guestOnly.id, quantity: 1 },
      ]),
      ...Array.from({ length: 5 }, () => cartService().getUserCart(user.id)),
      cartService().checkCartStock(user.id),
    ]);

    expect(await linkedCartIds(user.id)).toEqual([cart.id]);
    expect(await orphanCartIdsSinceStart()).toEqual([]);
    // Guest quantity is added to the existing line (capped by stock), as mergeGuestCart does.
    expect(variationCounts(await cartService().getUserCart(user.id))).toEqual({
      [shared.id]: 3,
      [guestOnly.id]: 1,
    });
  });
});

describe("repeated login / merge", () => {
  it("replays the same merge id without doubling quantities and never adds a cart", async () => {
    const user = await f.createUser();
    const first = await sellableVariation();
    const second = await sellableVariation();
    const mergeId = `merge-${user.id}-repeat`;
    const items = [{ productVariationId: first.id, quantity: 2 }];

    const results = await Promise.all([
      mergeGuestCart(strapi, user.id, mergeId, items),
      mergeGuestCart(strapi, user.id, mergeId, items),
      cartService().getUserCart(user.id),
    ]);
    expect(results.slice(0, 2).map((result: any) => result.replayed).sort()).toEqual([false, true]);

    // A later login with a fresh guest cart.
    await Promise.all([
      mergeGuestCart(strapi, user.id, `${mergeId}-next`, [{ productVariationId: second.id, quantity: 1 }]),
      cartService().getUserCart(user.id),
    ]);

    expect(await linkedCartIds(user.id)).toHaveLength(1);
    expect(await orphanCartIdsSinceStart()).toEqual([]);
    expect(variationCounts(await cartService().getUserCart(user.id))).toEqual({
      [first.id]: 2,
      [second.id]: 1,
    });
  });
});

describe("different customers", () => {
  it("gives concurrent customers their own carts without serializing them on one lock", async () => {
    const users = await Promise.all(Array.from({ length: 20 }, () => f.createUser()));

    const carts = await Promise.all(
      users.flatMap((user: any) => [cartService().getUserCart(user.id), cartService().getUserCart(user.id)]),
    );

    const linked = await Promise.all(users.map((user: any) => linkedCartIds(user.id)));
    expect(linked.every((ids) => ids.length === 1)).toBe(true);
    expect(new Set(linked.flat()).size).toBe(users.length);
    users.forEach((user: any, index: number) => {
      expect(carts[index * 2].id).toBe(linked[index][0]);
      expect(carts[index * 2 + 1].id).toBe(linked[index][0]);
    });
    expect(await orphanCartIdsSinceStart()).toEqual([]);
  });

  it("blocks only the customer whose lock is held", async () => {
    const [held, free] = await Promise.all([f.createUser(), f.createUser()]);
    const trx = await strapi.db.connection.transaction();
    try {
      await trx.raw("SELECT pg_advisory_xact_lock(?)", [held.id]);

      const blocked = cartService().getUserCart(held.id);
      const other = await within(cartService().getUserCart(free.id), 5_000);
      expect(other).not.toBe("pending");
      expect(await within(blocked, 300)).toBe("pending");

      await trx.commit();
      expect((await blocked).id).toBe((await linkedCartIds(held.id))[0]);
    } finally {
      if (!trx.isCompleted()) await trx.rollback();
    }
  });
});

describe("order-backed cart", () => {
  it("reuses the same cart after checkout consumes its lines", async () => {
    const user = await f.createUser();
    const variation = await sellableVariation();
    const cart = await cartService().getUserCart(user.id);
    await cartService().addCartItem(cart.id, variation.id, 1);
    const [line] = await cartLines(cart.id);
    const order = await f.createOrder({ status: "Started", userId: user.id });
    await f.createOrderItem({ orderId: order.id, variationId: variation.id, count: 1, sourceCartItemId: line.id });

    await consumeCheckoutCartLines(strapi, order.id);
    const again = await Promise.all([cartService().getUserCart(user.id), cartService().getUserCart(user.id)]);

    expect(again.map((row: any) => row.id)).toEqual([cart.id, cart.id]);
    expect(await linkedCartIds(user.id)).toEqual([cart.id]);
    expect((await f.getCart(cart.id)).Status).toBe("Empty");
  });
});

describe("guest merge failure", () => {
  it("rolls the whole merge back — no lines, no record, no cart — and a retry merges everything", async () => {
    const user = await f.createUser();
    const first = await sellableVariation();
    const second = await sellableVariation();
    const mergeId = `merge-${user.id}-rollback`;
    const items = [
      { productVariationId: first.id, quantity: 1 },
      { productVariationId: second.id, quantity: 1 },
    ];

    const realQuery = strapi.db.query.bind(strapi.db);
    let variationLookups = 0;
    const spy = jest.spyOn(strapi.db, "query").mockImplementation((uid: any) => {
      const repository = realQuery(uid);
      if (uid !== "api::product-variation.product-variation") return repository;
      return {
        ...repository,
        findOne: async (params: any) => {
          variationLookups += 1;
          if (variationLookups === 2) throw new Error("injected failure on the second line");
          return repository.findOne(params);
        },
      };
    });

    await expect(mergeGuestCart(strapi, user.id, mergeId, items)).rejects.toThrow(/injected failure/);
    spy.mockRestore();

    expect(await linkedCartIds(user.id)).toEqual([]);
    expect(await orphanCartIdsSinceStart()).toEqual([]);
    expect(
      await rows(`SELECT 1 FROM guest_cart_merges WHERE merge_id = ?`, [mergeId]),
    ).toHaveLength(0);

    const retried = await mergeGuestCart(strapi, user.id, mergeId, items);
    expect(retried).toEqual(expect.objectContaining({ replayed: false }));
    expect(variationCounts(await cartService().getUserCart(user.id))).toEqual({
      [first.id]: 1,
      [second.id]: 1,
    });
  });
});

describe("database invariant", () => {
  it("rejects a second cart linked to the same customer", async () => {
    expect(await indexExists()).toBe(true);
    const user = await f.createUser();
    await cartService().getUserCart(user.id);
    const [{ id: extraCartId }] = await rows(
      `INSERT INTO carts (status, created_at, updated_at) VALUES ('Empty', NOW(), NOW()) RETURNING id`,
    );

    await expect(
      strapi.db.connection.raw(`INSERT INTO carts_user_links (cart_id, user_id) VALUES (?, ?)`, [
        extraCartId,
        user.id,
      ]),
    ).rejects.toThrow(new RegExp(CART_ONE_PER_USER_INDEX));
    expect(await linkedCartIds(user.id)).toHaveLength(1);
  });
});

describe("repair of existing duplicate and orphaned carts", () => {
  let pool: any;

  beforeAll(() => {
    pool = new Pool({
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      database: process.env.DATABASE_NAME,
      user: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      max: 1,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  const runRepair = async (apply: boolean) => {
    const client = await pool.connect();
    try {
      return await repairUserCarts(client, { apply, includeOrphans: true });
    } finally {
      client.release();
    }
  };

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  /** A cart written the way the race left them: raw rows, optionally linked. */
  const seedCart = async (userId: number | null, activityAt: Date, createdAt = activityAt) => {
    const [{ id }] = await rows(
      `INSERT INTO carts (status, created_at, updated_at) VALUES ('Pending', ?, ?) RETURNING id`,
      [createdAt, activityAt],
    );
    if (userId) {
      await rows(`INSERT INTO carts_user_links (cart_id, user_id) VALUES (?, ?) RETURNING id`, [id, userId]);
    }
    f.remember("api::cart.cart", Number(id));
    return Number(id);
  };

  const seedLine = async (
    cartId: number,
    variationId: number,
    count: number,
    at: Date,
    price = 1000,
  ) => {
    const item = await f.createCartItem({ cartId, variationId, count, price });
    await rows(`UPDATE cart_items SET created_at = ?, updated_at = ? WHERE id = ?`, [at, at, item.id]);
    return Number(item.id);
  };

  const seedMergeRecord = async (userId: number, variationIds: number[], createdAt: Date) => {
    const record = await strapi.db.query("api::guest-cart-merge.guest-cart-merge").create({
      data: {
        MergeId: `seed-${userId}-${createdAt.getTime()}-${Math.floor(Math.random() * 1e6)}`,
        Result: {
          success: true,
          accepted: variationIds.map((productVariationId) => ({ productVariationId, quantity: 1 })),
          adjusted: [],
          rejected: [],
        },
        user: userId,
      },
    });
    await rows(`UPDATE guest_cart_merges SET created_at = ? WHERE id = ?`, [createdAt, record.id]);
    f.remember("api::guest-cart-merge.guest-cart-merge", record.id);
  };

  afterEach(async () => {
    expect(await ensureCartDatabaseInvariants(strapi)).toMatch(/installed|present/);
  });

  it("consolidates each customer onto the cart the storefront already serves, losing nothing", async () => {
    await dropCartIndex();
    const [emptyAndFull, bothFull, unequal, orderSource, boughtSince, orphanOwner, ambiguousA, ambiguousB] =
      await Promise.all(Array.from({ length: 8 }, () => f.createUser()));
    const v = await Promise.all(Array.from({ length: 10 }, () => sellableVariation()));
    const older = minutesAgo(60);
    const newer = minutesAgo(30);

    // 1. An empty cart beside one with lines (the most common production shape).
    const a1 = await seedCart(emptyAndFull.id, newer);
    const a2 = await seedCart(emptyAndFull.id, older);
    await seedLine(a2, v[0].id, 1, older);

    // 2. Both carts hold lines; the same variation re-added at the same quantity.
    const b1 = await seedCart(bothFull.id, older);
    const b1Shared = await seedLine(b1, v[0].id, 2, older);
    const b1Only = await seedLine(b1, v[1].id, 1, older);
    const b2 = await seedCart(bothFull.id, newer);
    const b2Shared = await seedLine(b2, v[0].id, 2, newer);

    // 3. The same variation at different quantities: the larger one wins, never the sum.
    const c1 = await seedCart(unequal.id, older);
    await seedLine(c1, v[2].id, 3, older, 1000);
    const c2 = await seedCart(unequal.id, newer);
    const c2Line = await seedLine(c2, v[2].id, 1, newer, 1000);
    await seedLine(c2, v[3].id, 1, newer);

    // 4. A moved line that a (cancelled) order points at stays reachable through cart.user.
    const d1 = await seedCart(orderSource.id, older);
    const d1Line = await seedLine(d1, v[4].id, 1, older);
    const d2 = await seedCart(orderSource.id, newer);
    await seedLine(d2, v[5].id, 1, newer);
    const cancelled = await f.createOrder({ status: "Cancelled", userId: orderSource.id });
    const cancelledItem = await f.createOrderItem({
      orderId: cancelled.id,
      variationId: v[4].id,
      sourceCartItemId: d1Line,
    });

    // 5. A line the customer has since bought in a live order stays behind.
    const e1 = await seedCart(boughtSince.id, older);
    const e1Line = await seedLine(e1, v[6].id, 1, older);
    const e2 = await seedCart(boughtSince.id, newer);
    await seedLine(e2, v[7].id, 1, newer);
    const done = await f.createOrder({ status: "Done", userId: boughtSince.id });
    await f.createOrderItem({ orderId: done.id, variationId: v[6].id });

    // 6. The merged guest cart whose link a concurrent create stole.
    const orphanAt = minutesAgo(45);
    const f1 = await seedCart(orphanOwner.id, newer);
    const orphan = await seedCart(null, orphanAt);
    await seedLine(orphan, v[8].id, 2, orphanAt);
    await seedMergeRecord(orphanOwner.id, [v[8].id], new Date(orphanAt.getTime() + 20));

    // 7. An orphan two different customers' merge records could explain: report only.
    const ambiguousAt = minutesAgo(40);
    const ambiguous = await seedCart(null, ambiguousAt);
    await seedLine(ambiguous, v[9].id, 1, ambiguousAt);
    await seedMergeRecord(ambiguousA.id, [v[9].id], new Date(ambiguousAt.getTime() + 15));
    await seedMergeRecord(ambiguousB.id, [v[9].id], new Date(ambiguousAt.getTime() + 25));

    const seededUsers = [emptyAndFull, bothFull, unequal, orderSource, boughtSince].map((user: any) => user.id);
    const resolvedBefore = new Map<number, number>();
    for (const userId of seededUsers) {
      resolvedBefore.set(userId, (await cartService().getUserCart(userId)).id);
    }
    const linksBefore = await rows(`SELECT COUNT(*)::int AS n FROM carts_user_links`);

    // Dry run: every step runs, then everything is rolled back.
    const dryRun = await runRepair(false);
    expect(dryRun.applied).toBe(false);
    expect(await indexExists()).toBe(false);
    expect(await rows(`SELECT COUNT(*)::int AS n FROM carts_user_links`)).toEqual(linksBefore);
    expect(await linkedCartIds(emptyAndFull.id)).toEqual([a1, a2].sort((x, y) => x - y));

    const report = await runRepair(true);
    expect(report.applied).toBe(true);
    expect(report.summary.indexInstalled).toBe(true);
    expect(await indexExists()).toBe(true);
    const planned = new Map(report.users.map((user) => [user.userId, user]));

    // The kept cart is the one the fixed resolver was already serving.
    for (const userId of seededUsers) {
      expect(planned.get(userId)?.keptCartId).toBe(resolvedBefore.get(userId));
      expect(await linkedCartIds(userId)).toEqual([resolvedBefore.get(userId)]);
    }

    expect(planned.get(emptyAndFull.id)).toEqual(
      expect.objectContaining({ keptCartId: a2, unlinkedCartIds: [a1], moved: [] }),
    );

    expect(planned.get(bothFull.id)?.keptCartId).toBe(b2);
    expect((await cartLines(b2)).map((line) => [line.id, line.variationId, line.count])).toEqual(
      [
        [b2Shared, v[0].id, 2],
        [b1Only, v[1].id, 1],
      ].sort((x, y) => x[1] - y[1]),
    );
    expect((await cartLines(b1)).map((line) => line.id)).toEqual([b1Shared]);

    expect(planned.get(unequal.id)?.raised).toEqual([
      expect.objectContaining({ cartItemId: c2Line, fromCount: 1, toCount: 3, toSum: 3000 }),
    ]);
    expect(Object.fromEntries((await cartLines(c2)).map((line) => [line.variationId, line.count]))).toEqual({
      [v[2].id]: 3,
      [v[3].id]: 1,
    });

    const reachable = await strapi.db.query("api::cart-item.cart-item").findOne({
      where: { id: d1Line, cart: { user: { id: orderSource.id } } },
    });
    expect(reachable?.id).toBe(d1Line);
    expect(
      (await rows(`SELECT source_cart_item_id FROM order_items WHERE id = ?`, [cancelledItem.id]))[0]
        .source_cart_item_id,
    ).toBe(d1Line);

    expect(planned.get(boughtSince.id)?.left).toEqual([
      expect.objectContaining({ cartItemId: e1Line, reason: "bought_since" }),
    ]);
    expect((await cartLines(e1)).map((line) => line.id)).toEqual([e1Line]);
    expect((await cartLines(e2)).map((line) => line.variationId)).toEqual([v[7].id]);

    expect(planned.get(orphanOwner.id)).toEqual(
      expect.objectContaining({ keptCartId: f1, recoveredOrphanCartIds: [orphan] }),
    );
    expect((await cartLines(f1)).map((line) => [line.variationId, line.count])).toEqual([[v[8].id, 2]]);
    expect(report.unattributedOrphans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cartId: ambiguous, reason: "several_matching_merges" }),
      ]),
    );
    expect(await linkedCartIds(ambiguousA.id)).toEqual([]);
    expect(await linkedCartIds(ambiguousB.id)).toEqual([]);

    // Nothing was deleted: every seeded cart row still exists.
    expect(
      (await rows(`SELECT COUNT(*)::int AS n FROM carts WHERE id = ANY(?::int[])`, [
        [a1, a2, b1, b2, c1, c2, d1, d2, e1, e2, f1, orphan, ambiguous],
      ]))[0].n,
    ).toBe(13);

    // Idempotent: a second run finds nothing for these customers and changes nothing.
    const again = await runRepair(true);
    const seededAll = new Set([...seededUsers, orphanOwner.id, ambiguousA.id, ambiguousB.id]);
    expect(again.users.filter((user) => seededAll.has(user.userId))).toEqual([]);
    expect(Object.fromEntries((await cartLines(c2)).map((line) => [line.variationId, line.count]))).toEqual({
      [v[2].id]: 3,
      [v[3].id]: 1,
    });
  });

  it("runs from the operator script: dry run by default, and --apply refuses without the database name", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnSync } = require("node:child_process");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("node:path");
    const script = path.resolve(__dirname, "../../../../scripts/repair-duplicate-user-carts.js");
    // Only the disposable test database: an empty DATABASE_URL also stops dotenv from
    // filling it in from a developer's .env.
    const env = { ...process.env, DATABASE_URL: "", DATABASE_SSL: "false" };

    const dryRun = spawnSync(process.execPath, [script, "--include-orphans"], { env, encoding: "utf8" });
    expect(dryRun.stderr).toMatch(new RegExp(`database=${process.env.DATABASE_NAME} .*mode=dry-run`));
    expect(dryRun.status).toBe(0);
    const report = JSON.parse(dryRun.stdout);
    expect(report).toEqual(
      expect.objectContaining({ applied: false, database: process.env.DATABASE_NAME }),
    );
    expect(report.summary.indexInstalled).toBe(true);

    const refused = spawnSync(process.execPath, [script, "--apply"], { env, encoding: "utf8" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/--apply requires --confirm-database/);
    expect(refused.stdout).toBe("");
  });
});
