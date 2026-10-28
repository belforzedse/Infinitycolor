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
import { adminAdjustItemsHandler } from "../../../api/order/controllers/helpers/adminAdjustItems";
import { finalizeGatewaySettlement } from "../../../api/order/controllers/helpers/gatewaySettlement";
import { decrementManualOrderStockHandler } from "../../../api/order/controllers/helpers/manualOrderStock";
import { restoreStockWithMandatoryAudit } from "../../../api/order/controllers/helpers/adminOrderIntegrity";
import { setupStrapi, teardownStrapi, getStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

let strapi: any;
let f: Factories;

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
  it("distinguishes a real database error from a shortage and leaves stock untouched", async () => {
    const stock = await f.createStock({ count: 10, reserved: 0 });
    await strapi.db.connection.transaction(async (trx: any) => {
      await trx.raw("SAVEPOINT inventory_failure");
      // Hide the table only inside this disposable transaction; never alter its schema.
      await trx.raw("SET LOCAL search_path = pg_temp");
      const result = await reserveStockAtomic(strapi, stock.id, 1, trx);
      expect(result.success).toBe(false);
      expect(result.reason).toBe("database_failure");
      await trx.raw("ROLLBACK TO SAVEPOINT inventory_failure");
    });
    expect(Number((await f.getStock(stock.id)).reservedCount)).toBe(0);
  });
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
    expect(results.find((result) => !result.success)?.reason).toBe("insufficient_stock");

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

describe("concurrent stock restoration", () => {
  it("preserves two +3 restorations and writes one stock log for each", async () => {
    const stock = await f.createStock({ count: 10, reserved: 0 });
    const order = await f.createOrder();

    await Promise.all([
      strapi.db.transaction(({ trx }: any) =>
        restoreStockWithMandatoryAudit(strapi, {
          stockId: stock.id,
          quantity: 3,
          orderId: order.id,
          cause: "Admin Order Adjustment",
          trx,
        }),
      ),
      strapi.db.transaction(({ trx }: any) =>
        restoreStockWithMandatoryAudit(strapi, {
          stockId: stock.id,
          quantity: 3,
          orderId: order.id,
          cause: "Admin Order Adjustment",
          trx,
        }),
      ),
    ]);

    expect(Number((await f.getStock(stock.id)).Count)).toBe(16);
    const logs = await strapi.db.query("api::product-stock-log.product-stock-log").findMany({
      where: {
        product_stock: { id: stock.id },
        Type: "Add",
        Cause: "Admin Order Adjustment",
      },
    });
    expect(logs).toHaveLength(2);
    expect(logs.map((log: any) => Number(log.Count))).toEqual([3, 3]);
    await strapi.db.query("api::product-stock-log.product-stock-log").deleteMany({
      where: { id: { $in: logs.map((log: any) => log.id) } },
    });
  });

  it("serializes a +3 restoration against a -2 decrement without a lost update", async () => {
    const stock = await f.createStock({ count: 10, reserved: 0 });
    const order = await f.createOrder();

    const [, decrement] = await Promise.all([
      strapi.db.transaction(({ trx }: any) =>
        restoreStockWithMandatoryAudit(strapi, {
          stockId: stock.id,
          quantity: 3,
          orderId: order.id,
          cause: "Admin Order Adjustment",
          trx,
        }),
      ),
      strapi.db.transaction(({ trx }: any) => decrementStockAtomic(strapi, stock.id, 2, trx)),
    ]);

    expect(decrement.success).toBe(true);
    expect(Number((await f.getStock(stock.id)).Count)).toBe(11);
    const logs = await strapi.db.query("api::product-stock-log.product-stock-log").findMany({
      where: {
        product_stock: { id: stock.id },
        Type: "Add",
        Cause: "Admin Order Adjustment",
      },
    });
    expect(logs).toHaveLength(1);
    await strapi.db.query("api::product-stock-log.product-stock-log").deleteMany({
      where: { id: { $in: logs.map((log: any) => log.id) } },
    });
  });
});

describe("consumeOrderReservation (order-level lifecycle)", () => {
  it("transitions Reserved→Consumed and decrements stock once (idempotent)", async () => {
    const { order, items } = await f.createReservedOrder({
      items: [{ count: 2, stockCount: 10, stockReserved: 2 }],
      reservedUntil: new Date(Date.now() + minutes(15)),
    });

    const first = await consumeOrderReservation(strapi, order.id);
    expect(first.outcome).toBe("consumed");

    let stock = await f.getStock(items[0].stockId);
    expect(Number(stock.Count)).toBe(8);
    expect(Number(stock.reservedCount)).toBe(0);
    expect((await f.getOrder(order.id)).ReservationStatus).toBe("Consumed");

    // Duplicate consume must NOT double-decrement.
    const second = await consumeOrderReservation(strapi, order.id);
    expect(second.outcome).toBe("skipped");
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
    expect(res.outcome).toBe("skipped");
    expect(res.outcome === "skipped" && res.expired).toBe(true);

    const stock = await f.getStock(items[0].stockId);
    expect(Number(stock.Count)).toBe(10); // unchanged
    expect(Number(stock.reservedCount)).toBe(2);
  });

  it("rolls back a three-line consume when line two lacks its reservation", async () => {
    const { order, items } = await f.createReservedOrder({
      items: [
        { count: 1, stockCount: 10, stockReserved: 1 },
        { count: 2, stockCount: 10, stockReserved: 1 },
        { count: 1, stockCount: 10, stockReserved: 1 },
      ],
      reservedUntil: new Date(Date.now() + minutes(15)),
    });

    await expect(consumeOrderReservation(strapi, order.id)).rejects.toThrow(
      /insufficient/i,
    );
    expect((await f.getOrder(order.id)).ReservationStatus).toBe("Reserved");
    const after = await Promise.all(items.map((item) => f.getStock(item.stockId)));
    expect(after.map((stock) => [Number(stock.Count), Number(stock.reservedCount)])).toEqual([
      [10, 1],
      [10, 1],
      [10, 1],
    ]);
  });
});

describe("releaseOrderReservation (order-level lifecycle)", () => {
  it("transitions Reserved→Released and frees stock once (idempotent)", async () => {
    const { order, items } = await f.createReservedOrder({
      items: [{ count: 3, stockCount: 10, stockReserved: 3 }],
      reservedUntil: new Date(Date.now() + minutes(15)),
    });

    const first = await releaseOrderReservation(strapi, order.id, "Released");
    expect(first.outcome).toBe("released");

    const stock = await f.getStock(items[0].stockId);
    expect(Number(stock.Count)).toBe(10); // count intact
    expect(Number(stock.reservedCount)).toBe(0); // reservation freed
    expect((await f.getOrder(order.id)).ReservationStatus).toBe("Released");

    const second = await releaseOrderReservation(strapi, order.id, "Released");
    expect(second.outcome).toBe("skipped");
    expect(Number((await f.getStock(items[0].stockId)).reservedCount)).toBe(0);
  });

  it("rolls back a three-line release when line two cannot be released", async () => {
    const { order, items } = await f.createReservedOrder({
      items: [
        { count: 1, stockCount: 10, stockReserved: 1 },
        { count: 2, stockCount: 10, stockReserved: 1 },
        { count: 1, stockCount: 10, stockReserved: 1 },
      ],
      reservedUntil: new Date(Date.now() + minutes(15)),
    });

    await expect(
      releaseOrderReservation(strapi, order.id, "Released"),
    ).rejects.toThrow(/insufficient/i);
    expect((await f.getOrder(order.id)).ReservationStatus).toBe("Reserved");
    const after = await Promise.all(items.map((item) => f.getStock(item.stockId)));
    expect(after.map((stock) => Number(stock.reservedCount))).toEqual([1, 1, 1]);
  });
});

describe.each(["SamanKish", "Mellat"] as const)(
  "%s provider-confirmed local settlement",
  (gateway) => {
    it("rolls back the attempt, reservation, stock, order, contract and transaction when line two fails", async () => {
      const payable = await f.createPayableOrder({
        gateway,
        items: [
          { count: 1, stockCount: 10, stockReserved: 1 },
          { count: 2, stockCount: 10, stockReserved: 1 },
          { count: 1, stockCount: 10, stockReserved: 1 },
        ],
      });
      const attempt = await f.createPaymentAttempt({
        userId: payable.userId,
        orderId: payable.order.id,
        contractId: payable.contract.id,
        amountIrr: payable.amountToman * 10,
        status: "Pending",
        gateway: gateway.toLowerCase(),
      });

      await expect(
        finalizeGatewaySettlement(strapi, {
          orderId: payable.order.id,
          contractId: payable.contract.id,
          contractTransactionId: payable.transaction.id,
          paymentAttemptId: attempt.id,
          gateway,
          contractTransactionData: {
            Amount: payable.amountToman * 10,
            external_id: payable.authority,
            external_source: gateway,
          },
          auditDescription: `${gateway} integration settlement`,
          auditChanges: { injected: true },
        }),
      ).rejects.toThrow(/insufficient/i);

      expect((await f.getOrder(payable.order.id)).Status).toBe("Paying");
      expect((await f.getOrder(payable.order.id)).ReservationStatus).toBe("Reserved");
      expect((await f.getContract(payable.contract.id)).Status).toBe("Not Ready");
      expect((await f.getContractTransaction(payable.transaction.id)).Status).toBe("Pending");
      const freshAttempt = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
        where: { id: attempt.id },
      });
      expect(freshAttempt.Status).toBe("Pending");
      const stocks = await Promise.all(payable.items.map((item) => f.getStock(item.stockId)));
      expect(stocks.map((stock) => [Number(stock.Count), Number(stock.reservedCount)])).toEqual([
        [10, 1],
        [10, 1],
        [10, 1],
      ]);
    });
  },
);

describe("provider-confirmed settlement audit atomicity", () => {
  it("rolls every local settlement mutation back when the mandatory audit insert fails", async () => {
    const payable = await f.createPayableOrder({ gateway: "SamanKish" });
    const attempt = await f.createPaymentAttempt({
      userId: payable.userId,
      orderId: payable.order.id,
      contractId: payable.contract.id,
      amountIrr: payable.amountToman * 10,
      status: "Pending",
      gateway: "samankish",
    });
    jest
      .spyOn(strapi.db.query("api::order-log.order-log"), "create")
      .mockRejectedValueOnce(new Error("injected settlement audit failure"));

    await expect(
      finalizeGatewaySettlement(strapi, {
        orderId: payable.order.id,
        contractId: payable.contract.id,
        contractTransactionId: payable.transaction.id,
        paymentAttemptId: attempt.id,
        gateway: "SamanKish",
        contractTransactionData: {
          Amount: payable.amountToman * 10,
          external_id: payable.authority,
          external_source: "SamanKish",
        },
        auditDescription: "Saman integration settlement",
        auditChanges: { injected: true },
      }),
    ).rejects.toThrow("injected settlement audit failure");

    expect((await f.getOrder(payable.order.id)).Status).toBe("Paying");
    expect((await f.getOrder(payable.order.id)).ReservationStatus).toBe("Reserved");
    expect((await f.getContract(payable.contract.id)).Status).toBe("Not Ready");
    expect((await f.getContractTransaction(payable.transaction.id)).Status).toBe("Pending");
    expect(Number((await f.getStock(payable.items[0].stockId)).reservedCount)).toBe(2);
    expect(
      (
        await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
          where: { id: attempt.id },
        })
      ).Status,
    ).toBe("Pending");

    jest.restoreAllMocks();
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

  it("rolls cancellation and stock release back when the expiry audit insert fails", async () => {
    const { order, items } = await f.createReservedOrder({
      items: [{ count: 2, stockCount: 10, stockReserved: 2 }],
      reservedUntil: new Date(Date.now() - minutes(30)),
    });
    jest
      .spyOn(strapi.db.query("api::order-log.order-log"), "create")
      .mockRejectedValueOnce(new Error("injected expiry audit failure"));

    await expect(
      runExpireStockReservationsTick(strapi, { now: new Date(), graceSeconds: 0 }),
    ).rejects.toThrow(/batch_failed/i);
    expect((await f.getOrder(order.id)).Status).toBe("Paying");
    expect((await f.getOrder(order.id)).ReservationStatus).toBe("Reserved");
    expect(Number((await f.getStock(items[0].stockId)).reservedCount)).toBe(2);

    jest.restoreAllMocks();
    await expect(
      runExpireStockReservationsTick(strapi, { now: new Date(), graceSeconds: 0 }),
    ).resolves.toMatchObject({ status: "completed" });
    expect((await f.getOrder(order.id)).Status).toBe("Cancelled");
    expect(Number((await f.getStock(items[0].stockId)).reservedCount)).toBe(0);
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

describe("manual-order stock application", () => {
  const manualStockCtx = (orderId: number, userId: number) => ({
    params: { id: String(orderId) },
    request: { body: {}, headers: {} },
    state: { user: { id: userId } },
    unauthorized: jest.fn(),
    forbidden: jest.fn(),
  });

  it("rolls back five lines on line three, then succeeds once and is idempotent", async () => {
    const actor = await createSuperadminActor();
    const order = await f.createOrder({ status: "Started", userId: actor.id });
    await strapi.db.query("api::order.order").update({
      where: { id: order.id },
      data: { Type: "Manual" },
    });

    const lines: Array<{ stockId: number; quantity: number }> = [];
    for (const [index, quantity] of [1, 1, 2, 1, 1].entries()) {
      const variation = await f.createVariation({
        stockCount: index === 2 ? 1 : 5,
        stockReserved: 0,
      });
      await f.createOrderItem({
        orderId: order.id,
        variationId: variation.id,
        count: quantity,
      });
      lines.push({ stockId: variation.stockId, quantity });
    }

    const firstCtx: any = manualStockCtx(order.id, actor.id);
    await decrementManualOrderStockHandler(strapi, firstCtx);
    expect(firstCtx.status).toBe(409);
    expect(firstCtx.body?.data?.errorCode).toBe("MANUAL_STOCK_DECREMENT_FAILED");
    expect(
      await Promise.all(lines.map(async (line) => Number((await f.getStock(line.stockId)).Count))),
    ).toEqual([5, 5, 1, 5, 5]);
    expect((await f.getOrder(order.id)).ManualStockAppliedAt).toBeFalsy();

    await strapi.db.query("api::product-stock.product-stock").update({
      where: { id: lines[2].stockId },
      data: { Count: 5 },
    });

    const retryCtx: any = manualStockCtx(order.id, actor.id);
    await decrementManualOrderStockHandler(strapi, retryCtx);
    expect(retryCtx.status).toBe(200);
    expect(retryCtx.body?.data).toEqual(expect.objectContaining({ success: true, applied: true }));
    const afterRetry = await Promise.all(
      lines.map(async (line) => Number((await f.getStock(line.stockId)).Count)),
    );
    expect(afterRetry).toEqual([4, 4, 3, 4, 4]);
    expect((await f.getOrder(order.id)).ManualStockAppliedAt).toBeTruthy();

    const duplicateCtx: any = manualStockCtx(order.id, actor.id);
    await decrementManualOrderStockHandler(strapi, duplicateCtx);
    expect(duplicateCtx.status).toBe(200);
    expect(duplicateCtx.body?.data).toEqual({ success: true, alreadyApplied: true });
    expect(
      await Promise.all(lines.map(async (line) => Number((await f.getStock(line.stockId)).Count))),
    ).toEqual(afterRetry);
  });
});

describe("admin cancellation rolls back atomically", () => {
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

  const adjustCtx = (orderId: number, orderItemId: number, userId: number) => ({
    params: { id: String(orderId) },
    query: {},
    request: {
      body: {
        items: [{ orderItemId, newCount: 1 }],
        reason: "integration adjustment",
      },
      headers: {},
    },
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

  it("rolls paid cancellation back when the mandatory wallet ledger insert fails", async () => {
    const actor = await createSuperadminActor();
    const wallet = await f.createWallet({ userId: actor.id, balanceIrr: 0 });
    const contract = await f.createContract({
      amount: 100_000,
      status: "Confirmed",
      userId: actor.id,
    });
    await f.createContractTransaction({
      contractId: contract.id,
      amount: 1_000_000,
      status: "Success",
      type: "Gateway",
      step: 1,
      externalSource: "SamanKish",
    });
    const order = await f.createOrder({
      status: "Started",
      reservationStatus: "Consumed",
      userId: actor.id,
      contractId: contract.id,
      paymentGateway: "SamanKish",
    });
    const variation = await f.createVariation({ stockCount: 8, stockReserved: 0 });
    await f.createOrderItem({
      orderId: order.id,
      variationId: variation.id,
      count: 2,
      perAmount: 50_000,
    });
    jest
      .spyOn(
        strapi.db.query("api::local-user-wallet-transaction.local-user-wallet-transaction"),
        "create",
      )
      .mockRejectedValueOnce(new Error("injected refund ledger failure"));

    const ctx: any = cancelCtx(order.id, actor.id);
    const response: any = await adminCancelOrderHandler(strapi, ctx);
    expect(response?.error).toBe("Failed to cancel order");
    expect((await f.getOrder(order.id)).Status).toBe("Started");
    expect((await f.getContract(contract.id)).Status).toBe("Confirmed");
    expect(Number((await f.getStock(variation.stockId)).Count)).toBe(8);
    expect(
      Number(
        (
          await strapi.db.query("api::local-user-wallet.local-user-wallet").findOne({
            where: { id: wallet.id },
          })
        ).Balance,
      ),
    ).toBe(0);
    expect(
      (await f.getContractTransactions(contract.id)).filter(
        (transaction: any) => transaction.Type === "Return",
      ),
    ).toHaveLength(0);
    expect(
      await strapi.db.query("api::product-stock-log.product-stock-log").findMany({
        where: {
          product_stock: { id: variation.stockId },
          Cause: "Admin Order Cancellation",
        },
      }),
    ).toHaveLength(0);

    jest.restoreAllMocks();
  });

  it("serializes simultaneous cancel and adjustment so exactly one request has side effects", async () => {
    const actor = await createSuperadminActor();
    const wallet = await f.createWallet({ userId: actor.id, balanceIrr: 0 });
    const contract = await f.createContract({
      amount: 100_000,
      status: "Confirmed",
      userId: actor.id,
    });
    const paidTransaction = await f.createContractTransaction({
      contractId: contract.id,
      amount: 1_000_000,
      status: "Success",
      type: "Gateway",
      step: 1,
      externalSource: "SamanKish",
    });
    const order = await f.createOrder({
      status: "Started",
      reservationStatus: "Consumed",
      userId: actor.id,
      contractId: contract.id,
      paymentGateway: "SamanKish",
    });
    const variation = await f.createVariation({ stockCount: 8, stockReserved: 0 });
    const orderItem = await f.createOrderItem({
      orderId: order.id,
      variationId: variation.id,
      count: 2,
      perAmount: 50_000,
    });

    const orderQuery = strapi.db.query("api::order.order");
    const originalFindOne = orderQuery.findOne.bind(orderQuery);
    let preflightArrivals = 0;
    let releasePreflights!: () => void;
    const bothPreflightsArrived = new Promise<void>((resolve) => {
      releasePreflights = resolve;
    });
    jest.spyOn(orderQuery, "findOne").mockImplementation(async (args: any) => {
      const isThisPreflight =
        Number(args?.where?.id) === order.id && !args?.transacting && preflightArrivals < 2;
      if (isThisPreflight) {
        preflightArrivals += 1;
        if (preflightArrivals === 2) releasePreflights();
        await bothPreflightsArrived;
      }
      return originalFindOne(args);
    });

    const firstCtx: any = cancelCtx(order.id, actor.id);
    const secondCtx: any = adjustCtx(order.id, orderItem.id, actor.id);
    const responses = await Promise.all([
      adminCancelOrderHandler(strapi, firstCtx),
      adminAdjustItemsHandler(strapi, secondCtx),
    ]);
    jest.restoreAllMocks();

    expect(responses.filter((response: any) => response?.data?.success)).toHaveLength(1);
    expect(firstCtx.conflict.mock.calls.length + secondCtx.conflict.mock.calls.length).toBe(1);
    const conflictCtx = firstCtx.conflict.mock.calls.length ? firstCtx : secondCtx;
    expect(conflictCtx.conflict).toHaveBeenCalledWith(
      "Order changed concurrently",
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: "ORDER_CHANGED_CONCURRENTLY" }),
      }),
    );

    const successful = responses.find((response: any) => response?.data?.success) as any;
    const cancellationWon = successful.data.status === "cancelled";
    const expectedRestoration = cancellationWon ? 2 : 1;
    expect(["Cancelled", "Started"]).toContain((await f.getOrder(order.id)).Status);
    expect(Number((await f.getStock(variation.stockId)).Count)).toBe(8 + expectedRestoration);
    const stockLogs = await strapi.db.query("api::product-stock-log.product-stock-log").findMany({
      where: {
        product_stock: { id: variation.stockId },
        Type: "Add",
        Cause: { $in: ["Admin Order Cancellation", "Admin Order Adjustment"] },
      },
    });
    expect(stockLogs).toHaveLength(1);
    expect(Number(stockLogs[0].Count)).toBe(expectedRestoration);

    const freshWallet = await strapi.db.query("api::local-user-wallet.local-user-wallet").findOne({
      where: { id: wallet.id },
    });
    expect(Number(freshWallet.Balance)).toBe(expectedRestoration * 500_000);
    const ledger = await strapi.db
      .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
      .findMany({ where: { user_wallet: { id: wallet.id } } });
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].Amount)).toBe(expectedRestoration * 500_000);

    const transactions = await f.getContractTransactions(contract.id);
    const returns = transactions.filter((transaction: any) => transaction.Type === "Return");
    expect(returns).toHaveLength(1);
    expect(Number(returns[0].Step)).toBe(Number(paidTransaction.Step) + 1);
    expect(
      (await f.getOrderLogs(order.id)).filter((log: any) =>
        String(log.Description).startsWith("Admin "),
      ),
    ).toHaveLength(1);

    await strapi.db.query("api::product-stock-log.product-stock-log").deleteMany({
      where: { id: { $in: stockLogs.map((log: any) => log.id) } },
    });
    await strapi.db.query("api::contract-transaction.contract-transaction").deleteMany({
      where: { id: { $in: returns.map((transaction: any) => transaction.id) } },
    });
  });
});
