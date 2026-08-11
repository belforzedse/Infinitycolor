/**
 * Tier 1 integration suite — stock integrity & reservation lifecycle.
 *
 * Runs against a REAL Strapi + REAL Postgres (Testcontainers). Booting Strapi
 * is expensive (schema migration + bootstrap seeding), and a function-level
 * integration test needs the in-process `strapi` object, so all Tier 1 specs
 * share a SINGLE boot in this one file. External providers (Redis, gateways,
 * SMS, CDN/revalidation) are mocked in setup.int.ts; persistence/business
 * logic is real.
 *
 * Why this matters: the atomic stock SQL uses Postgres `... RETURNING ...` +
 * `result.rows`, which the previous SQLite/mock setup could not validate — so
 * oversell prevention was effectively untested against the production engine.
 */
import {
  reserveStockAtomic,
  consumeReservedStockAtomic,
  releaseReservedStockAtomic,
  decrementStockAtomic,
} from "../../../api/cart/services/lib/stock";
import { consumeOrderReservation, releaseOrderReservation } from "../../../utils/stockReservations";
import { runExpireStockReservationsTick } from "../../../jobs/expireStockReservations";
import { adminCancelOrderHandler } from "../../../api/order/controllers/helpers/adminCancel";
import { setupStrapi, teardownStrapi, getStrapi } from "../strapiInstance";
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

describe("harness", () => {
  it("boots a real Strapi on a real Postgres connection", () => {
    expect(getStrapi().db).toBeDefined();
    expect(getStrapi().db.config.connection.client).toBe("postgres");
  });
});

describe("reserveStockAtomic", () => {
  it("increments reservedCount when stock is available", async () => {
    const stock = await f.createStock({ count: 10, reserved: 0 });
    const res = await reserveStockAtomic(strapi, stock.id, 3);
    expect(res.success).toBe(true);
    expect(Number(res.newReservedCount)).toBe(3);
    expect(Number((await f.getStock(stock.id)).reservedCount)).toBe(3);
  });

  it("rejects a reservation that exceeds available stock and leaves DB unchanged", async () => {
    const stock = await f.createStock({ count: 5, reserved: 3 }); // available = 2
    const res = await reserveStockAtomic(strapi, stock.id, 3);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/insufficient/i);
    expect(Number((await f.getStock(stock.id)).reservedCount)).toBe(3); // unchanged
  });

  it("never oversells under concurrency (only available-many succeed)", async () => {
    const stock = await f.createStock({ count: 5, reserved: 0 });
    // Five concurrent attempts to reserve 2 each → at most 2 can succeed (4 ≤ 5).
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveStockAtomic(strapi, stock.id, 2)),
    );
    expect(results.filter((r) => r.success).length).toBe(2);
    const final = await f.getStock(stock.id);
    expect(Number(final.reservedCount)).toBeLessThanOrEqual(Number(final.Count));
    expect(Number(final.reservedCount)).toBe(4);
  });

  it("allows only one buyer to reserve the last unit", async () => {
    const stock = await f.createStock({ count: 1, reserved: 0 });

    const results = await Promise.all([
      reserveStockAtomic(strapi, stock.id, 1),
      reserveStockAtomic(strapi, stock.id, 1),
    ]);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success)).toHaveLength(1);
    expect(results.find((result) => !result.success)?.error).toMatch(/insufficient/i);

    const final = await f.getStock(stock.id);
    expect(Number(final.Count)).toBe(1);
    expect(Number(final.reservedCount)).toBe(1);
  });
});

describe("consumeReservedStockAtomic", () => {
  it("decrements both Count and reservedCount on success", async () => {
    const stock = await f.createStock({ count: 10, reserved: 4 });
    const res = await consumeReservedStockAtomic(strapi, stock.id, 4);
    expect(res.success).toBe(true);
    const after = await f.getStock(stock.id);
    expect(Number(after.Count)).toBe(6);
    expect(Number(after.reservedCount)).toBe(0);
  });

  it("fails when there is not enough reserved to consume", async () => {
    const stock = await f.createStock({ count: 10, reserved: 1 });
    const res = await consumeReservedStockAtomic(strapi, stock.id, 4);
    expect(res.success).toBe(false);
    const after = await f.getStock(stock.id);
    expect(Number(after.Count)).toBe(10); // unchanged
    expect(Number(after.reservedCount)).toBe(1);
  });
});

describe("releaseReservedStockAtomic", () => {
  it("decrements reservedCount only, leaving Count intact", async () => {
    const stock = await f.createStock({ count: 10, reserved: 4 });
    const res = await releaseReservedStockAtomic(strapi, stock.id, 4);
    expect(res.success).toBe(true);
    const after = await f.getStock(stock.id);
    expect(Number(after.Count)).toBe(10);
    expect(Number(after.reservedCount)).toBe(0);
  });

  it("fails when releasing more than is reserved", async () => {
    const stock = await f.createStock({ count: 10, reserved: 2 });
    const res = await releaseReservedStockAtomic(strapi, stock.id, 5);
    expect(res.success).toBe(false);
    expect(Number((await f.getStock(stock.id)).reservedCount)).toBe(2);
  });
});

describe("decrementStockAtomic", () => {
  it("never lets Count go negative", async () => {
    const stock = await f.createStock({ count: 3, reserved: 0 });
    const res = await decrementStockAtomic(strapi, stock.id, 5);
    expect(res.success).toBe(false);
    expect(Number((await f.getStock(stock.id)).Count)).toBe(3);
  });
});

describe("consumeOrderReservation (order-level lifecycle)", () => {
  it("transitions Reserved→Consumed and decrements stock once (idempotent)", async () => {
    const { order, items } = await f.createReservedOrder({
      items: [{ count: 2, stockCount: 10, stockReserved: 2 }],
      reservedUntil: new Date(Date.now() + minutes(15)),
    });

    const first = await consumeOrderReservation(strapi, order.id);
    expect(first.success).toBe(true);

    let stock = await f.getStock(items[0].stockId);
    expect(Number(stock.Count)).toBe(8);
    expect(Number(stock.reservedCount)).toBe(0);
    expect((await f.getOrder(order.id)).ReservationStatus).toBe("Consumed");

    // Duplicate consume must NOT double-decrement.
    const second = await consumeOrderReservation(strapi, order.id);
    expect(second.success).toBe(true);
    expect(second.skipped).toBe(true);
    stock = await f.getStock(items[0].stockId);
    expect(Number(stock.Count)).toBe(8);
    expect(Number(stock.reservedCount)).toBe(0);
  });

  it("refuses to consume an expired reservation (stock untouched)", async () => {
    const { order, items } = await f.createReservedOrder({
      items: [{ count: 2, stockCount: 10, stockReserved: 2 }],
      // A small 5-minute delta: this used to be misclassified as not-expired by
      // the old `reserved_until >= NOW()` guard (timestamp vs timestamptz). It now
      // passes because the guard binds a JS Date — regression test for that fix.
      reservedUntil: new Date(Date.now() - minutes(5)),
    });

    const res = await consumeOrderReservation(strapi, order.id);
    expect(res.skipped).toBe(true);
    expect(res.expired).toBe(true);

    const stock = await f.getStock(items[0].stockId);
    expect(Number(stock.Count)).toBe(10); // unchanged
    expect(Number(stock.reservedCount)).toBe(2);
  });
});

describe("releaseOrderReservation (order-level lifecycle)", () => {
  it("transitions Reserved→Released and frees stock once (idempotent)", async () => {
    const { order, items } = await f.createReservedOrder({
      items: [{ count: 3, stockCount: 10, stockReserved: 3 }],
      reservedUntil: new Date(Date.now() + minutes(15)),
    });

    const first = await releaseOrderReservation(strapi, order.id, "Released");
    expect(first.success).toBe(true);

    const stock = await f.getStock(items[0].stockId);
    expect(Number(stock.Count)).toBe(10); // count intact
    expect(Number(stock.reservedCount)).toBe(0); // reservation freed
    expect((await f.getOrder(order.id)).ReservationStatus).toBe("Released");

    const second = await releaseOrderReservation(strapi, order.id, "Released");
    expect(second.success).toBe(true);
    expect(second.skipped).toBe(true);
    expect(Number((await f.getStock(items[0].stockId)).reservedCount)).toBe(0);
  });
});

describe("expiry job (runExpireStockReservationsTick)", () => {
  it("cancels a stale Paying order and releases its reserved stock", async () => {
    const { order, items } = await f.createReservedOrder({
      items: [{ count: 2, stockCount: 10, stockReserved: 2 }],
      reservedUntil: new Date(Date.now() - minutes(30)), // well past expiry
    });

    const result = await runExpireStockReservationsTick(strapi, { now: new Date(), graceSeconds: 0 });
    expect(result.status).toBe("completed");

    const finalOrder = await f.getOrder(order.id);
    expect(finalOrder.Status).toBe("Cancelled");
    expect(finalOrder.ReservationStatus).toBe("Expired");

    const stock = await f.getStock(items[0].stockId);
    expect(Number(stock.reservedCount)).toBe(0); // released
    expect(Number(stock.Count)).toBe(10); // never deducted
  });

  it("leaves a still-valid reservation untouched", async () => {
    const { order, items } = await f.createReservedOrder({
      items: [{ count: 1, stockCount: 5, stockReserved: 1 }],
      reservedUntil: new Date(Date.now() + minutes(30)), // not expired
    });

    await runExpireStockReservationsTick(strapi, { now: new Date(), graceSeconds: 0 });

    expect((await f.getOrder(order.id)).Status).toBe("Paying");
    expect(Number((await f.getStock(items[0].stockId)).reservedCount)).toBe(1);
  });
});

describe("transaction propagation for reserved-stock release", () => {
  /**
   * The defect: `releaseReservedStockAtomic` issues raw SQL, and raw SQL does not inherit
   * the ambient transaction the way `strapi.db.query` does. The admin cancel/adjust paths
   * opened `strapi.db.transaction(async () => …)` without destructuring `trx`, so the
   * reserved_count decrement went straight to the pool and survived a rollback of the
   * surrounding operation. Nothing is mocked away here — the transaction being tested is
   * a real one on real Postgres.
   */
  it("rolls the release back with the outer transaction when trx is passed", async () => {
    const stock = await f.createStock({ count: 10, reserved: 4 });

    await expect(
      strapi.db.transaction(async ({ trx }: any) => {
        const released = await releaseReservedStockAtomic(strapi, stock.id, 4, trx);
        expect(released.success).toBe(true);
        throw new Error("injected failure after release");
      }),
    ).rejects.toThrow("injected failure after release");

    expect(Number((await f.getStock(stock.id)).reservedCount)).toBe(4);
  });

  it("rolls back even when a caller forgets to pass trx", async () => {
    const stock = await f.createStock({ count: 10, reserved: 4 });

    await expect(
      strapi.db.transaction(async () => {
        // No trx handed over: the executor resolver must fall back to the ambient
        // transaction rather than the base connection.
        const released = await releaseReservedStockAtomic(strapi, stock.id, 4);
        expect(released.success).toBe(true);
        throw new Error("injected failure after release");
      }),
    ).rejects.toThrow("injected failure after release");

    expect(Number((await f.getStock(stock.id)).reservedCount)).toBe(4);
  });

  it("commits normally when the transaction succeeds", async () => {
    const stock = await f.createStock({ count: 10, reserved: 4 });

    await strapi.db.transaction(async ({ trx }: any) => {
      await releaseReservedStockAtomic(strapi, stock.id, 4, trx);
    });

    expect(Number((await f.getStock(stock.id)).reservedCount)).toBe(0);
  });

  it("still works for a legitimately standalone caller", async () => {
    const stock = await f.createStock({ count: 10, reserved: 4 });

    const released = await releaseReservedStockAtomic(strapi, stock.id, 4);

    expect(released.success).toBe(true);
    expect(Number((await f.getStock(stock.id)).reservedCount)).toBe(0);
  });
});

describe("admin cancellation rolls back atomically", () => {
  const createSuperadminActor = async () => {
    const roleQuery = strapi.query("plugin::users-permissions.role");
    let role = await roleQuery.findOne({ where: { type: "superadmin" } });
    if (!role) {
      role = await roleQuery.create({
        data: { name: "Superadmin", type: "superadmin", description: "integration actor" },
      });
    }
    const user = await f.createUser();
    await strapi.query("plugin::users-permissions.user").update({
      where: { id: user.id },
      data: { role: role.id },
    });
    return user;
  };

  const cancelCtx = (orderId: number, userId: number) => ({
    params: { id: String(orderId) },
    request: { body: { reason: "integration cancellation" }, headers: {} },
    state: { user: { id: userId } },
    badRequest: jest.fn(),
    notFound: jest.fn(),
    conflict: jest.fn(),
    forbidden: jest.fn(),
    unauthorized: jest.fn(),
    internalServerError: jest.fn((message: string, payload?: unknown) => ({
      error: message,
      payload,
    })),
  });

  it("leaves order, reservation and stock untouched when a later step fails", async () => {
    const actor = await createSuperadminActor();
    const contract = await f.createContract({ amount: 0, status: "Not Ready" });
    const { order, items } = await f.createReservedOrder({
      items: [{ count: 2, stockCount: 10, stockReserved: 2 }],
      userId: actor.id,
      contractId: contract.id,
    });

    // Fails after the reservation release, inside the same transaction.
    jest
      .spyOn(strapi.db.query("api::order-log.order-log"), "create")
      .mockRejectedValueOnce(new Error("injected order-log failure"));

    const ctx = cancelCtx(order.id, actor.id);
    // The handler reports the failure rather than throwing; what matters is that nothing
    // it had already written survived.
    const response: any = await adminCancelOrderHandler(strapi, ctx);
    expect(response?.error).toBe("Failed to cancel order");

    const unchangedOrder = await f.getOrder(order.id);
    expect(unchangedOrder.Status).toBe("Paying");
    expect(unchangedOrder.ReservationStatus).toBe("Reserved");

    const stock = await f.getStock(items[0].stockId);
    expect(Number(stock.Count)).toBe(10);
    expect(Number(stock.reservedCount)).toBe(2);

    expect((await f.getContract(contract.id)).Status).toBe("Not Ready");

    jest.restoreAllMocks();
  });

  it("commits order, reservation and stock together on the happy path", async () => {
    const actor = await createSuperadminActor();
    const contract = await f.createContract({ amount: 0, status: "Not Ready" });
    const { order, items } = await f.createReservedOrder({
      items: [{ count: 2, stockCount: 10, stockReserved: 2 }],
      userId: actor.id,
      contractId: contract.id,
    });

    const ctx = cancelCtx(order.id, actor.id);
    const response: any = await adminCancelOrderHandler(strapi, ctx);
    expect(ctx.forbidden).not.toHaveBeenCalled();
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(ctx.notFound).not.toHaveBeenCalled();
    expect(ctx.internalServerError).not.toHaveBeenCalled();
    expect(response?.data?.success).toBe(true);

    const cancelled = await f.getOrder(order.id);
    expect(cancelled.Status).toBe("Cancelled");
    expect(cancelled.ReservationStatus).toBe("Released");

    const stock = await f.getStock(items[0].stockId);
    expect(Number(stock.Count)).toBe(10); // never paid, so never deducted
    expect(Number(stock.reservedCount)).toBe(0);
    expect((await f.getContract(contract.id)).Status).toBe("Cancelled");
  });
});
