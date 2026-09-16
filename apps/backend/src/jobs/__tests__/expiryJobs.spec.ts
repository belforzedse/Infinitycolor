import { releaseOrderReservation } from "../../utils/stockReservations";
import { __resetBackgroundJobGuardsForTests } from "../backgroundJobRunner";
import { runExpireReserveOrdersTick } from "../expireReserveOrders";
import { runExpireStockReservationsTick } from "../expireStockReservations";

jest.mock("../../utils/stockReservations", () => ({
  releaseOrderReservation: jest.fn(),
}));

const mockedReleaseOrderReservation = releaseOrderReservation as jest.MockedFunction<
  typeof releaseOrderReservation
>;

function createMockStrapi() {
  const orderQuery = {
    findOne: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  };
  const contractQuery = {
    update: jest.fn(),
  };
  const orderLogQuery = {
    create: jest.fn(),
  };
  const paymentAttemptQuery = {
    findOne: jest.fn().mockResolvedValue(null),
  };
  const snappayOrchestrator = {
    reconcileOrder: jest.fn().mockResolvedValue(undefined),
  };

  const trx = {
    raw: jest.fn(),
  };

  const strapi = {
    log: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
    entityService: {
      findMany: jest.fn(),
    },
    db: {
      connection: {
        raw: jest.fn(),
      },
      transaction: jest.fn(async (callback: any) => callback({ trx })),
      query: jest.fn((uid: string) => {
        if (uid === "api::order.order") return orderQuery;
        if (uid === "api::contract.contract") return contractQuery;
        if (uid === "api::order-log.order-log") return orderLogQuery;
        if (uid === "api::payment-attempt.payment-attempt") {
          return paymentAttemptQuery;
        }
        throw new Error(`Unexpected uid: ${uid}`);
      }),
    },
    service: jest.fn((uid: string) => {
      if (uid === "api::payment-gateway.snappay-orchestrator") {
        return snappayOrchestrator;
      }
      throw new Error(`Unexpected service uid: ${uid}`);
    }),
    metrics: {
      increment: jest.fn(),
    },
  } as any;

  return {
    strapi,
    orderQuery,
    contractQuery,
    orderLogQuery,
    paymentAttemptQuery,
    snappayOrchestrator,
  };
}

describe("expiry jobs", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, DATABASE_CLIENT: "sqlite" };
    jest.clearAllMocks();
    __resetBackgroundJobGuardsForTests();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("runs expireStockReservations without relying on global strapi", async () => {
    const previousGlobalStrapi = (global as any).strapi;
    delete (global as any).strapi;

    const { strapi, orderQuery, contractQuery, orderLogQuery } = createMockStrapi();
    const now = new Date("2026-05-30T12:00:00.000Z");
    strapi.entityService.findMany.mockResolvedValue([{ id: 10 }]);
    orderQuery.findOne.mockResolvedValue({ id: 10, contract: { id: 55 } });
    strapi.db.transaction.mockImplementationOnce(async (callback: any) => {
      const trx = { raw: jest.fn().mockResolvedValue({ rows: [{ id: 10 }] }) };
      return callback({ trx });
    });
    contractQuery.update.mockResolvedValue({ id: 55 });
    orderLogQuery.create.mockResolvedValue({ id: 1 });
    mockedReleaseOrderReservation.mockResolvedValue({ success: true });

    const result = await runExpireStockReservationsTick(strapi, {
      now,
      graceSeconds: 60,
      batchSize: 25,
    });

    expect(result.status).toBe("completed");
    expect(result.stats.processed).toBe(1);
    expect(strapi.entityService.findMany).toHaveBeenCalledWith(
      "api::order.order",
      expect.objectContaining({
        filters: expect.objectContaining({
          Status: "Paying",
          ReservationStatus: "Reserved",
        }),
        limit: 25,
      })
    );
    expect(mockedReleaseOrderReservation).toHaveBeenCalledWith(
      strapi,
      10,
      "Expired",
      expect.anything(),
      expect.objectContaining({
        requireOrderStatus: "Paying",
        expiresBefore: new Date("2026-05-30T11:59:00.000Z"),
      })
    );
    expect(orderQuery.update).not.toHaveBeenCalled();
    expect(contractQuery.update).not.toHaveBeenCalled();
    expect(orderLogQuery.create).toHaveBeenCalledTimes(1);

    (global as any).strapi = previousGlobalStrapi;
  });

  it("does not cancel orders when the reservation transition is skipped", async () => {
    const { strapi, orderQuery, contractQuery } = createMockStrapi();
    strapi.entityService.findMany.mockResolvedValue([{ id: 11 }]);
    mockedReleaseOrderReservation.mockResolvedValue({ success: true, skipped: true });

    const result = await runExpireStockReservationsTick(strapi, {
      now: new Date("2026-05-30T12:00:00.000Z"),
      graceSeconds: 0,
    });

    expect(result.status).toBe("completed");
    expect(result.stats.skipped).toBe(1);
    expect(orderQuery.update).not.toHaveBeenCalled();
    expect(contractQuery.update).not.toHaveBeenCalled();
  });

  it("never cancels or logs a paid/consumed order picked up at the boundary", async () => {
    const { strapi, orderQuery, contractQuery, orderLogQuery } = createMockStrapi();
    strapi.entityService.findMany.mockResolvedValue([{ id: 12 }]);
    // releaseOrderReservation reports skipped because the order is no longer "Reserved"
    // (e.g. it was just paid and consumed) — the guarded transition matched 0 rows.
    mockedReleaseOrderReservation.mockResolvedValue({ success: true, skipped: true });

    const result = await runExpireStockReservationsTick(strapi, {
      now: new Date("2026-05-30T12:00:00.000Z"),
      graceSeconds: 0,
    });

    expect(result.status).toBe("completed");
    expect(result.stats.skipped).toBe(1);
    expect(result.stats.processed).toBe(0);
    expect(orderQuery.update).not.toHaveBeenCalled();
    expect(contractQuery.update).not.toHaveBeenCalled();
    expect(orderLogQuery.create).not.toHaveBeenCalled();
  });

  it("defers expiry and reconciles an active SnappPay attempt", async () => {
    const {
      strapi,
      orderQuery,
      paymentAttemptQuery,
      snappayOrchestrator,
    } = createMockStrapi();
    strapi.entityService.findMany.mockResolvedValue([{ id: 13 }]);
    paymentAttemptQuery.findOne.mockResolvedValue({
      id: 113,
      attemptId: "snappay-attempt-13",
      Status: "Unknown",
    });
    orderQuery.update.mockResolvedValue({ id: 13 });

    const result = await runExpireStockReservationsTick(strapi, {
      now: new Date("2026-05-30T12:00:00.000Z"),
      graceSeconds: 0,
    });

    expect(result.status).toBe("completed");
    expect(result.stats.skipped).toBe(1);
    expect(result.stats.processed).toBe(0);
    expect(orderQuery.update).toHaveBeenCalledWith({
      where: {
        id: 13,
        Status: "Paying",
        ReservationStatus: "Reserved",
      },
      data: {
        ReservedUntil: new Date("2026-05-30T12:05:00.000Z"),
      },
    });
    expect(snappayOrchestrator.reconcileOrder).toHaveBeenCalledWith(
      13,
      "reservation_expiry",
    );
    expect(mockedReleaseOrderReservation).not.toHaveBeenCalled();
  });

  // Regression: markManualReview parks an exhausted attempt as Status "Unknown"
  // with nextActionAt null. "Unknown" is inside the deferral set, so keying the
  // deferral on Status alone extended ReservedUntil every minute forever while
  // nothing could ever resolve it — the reserved units left sellable inventory
  // permanently, with the operator locked out by a 409.
  it("releases the reservation for a SnappPay attempt parked for manual review", async () => {
    const {
      strapi,
      orderQuery,
      contractQuery,
      orderLogQuery,
      paymentAttemptQuery,
      snappayOrchestrator,
    } = createMockStrapi();
    strapi.entityService.findMany.mockResolvedValue([{ id: 14 }]);
    paymentAttemptQuery.findOne.mockResolvedValue({
      id: 114,
      attemptId: "snappay-attempt-14",
      Status: "Unknown",
      nextAction: "manual_review",
      nextActionAt: null,
      createdAt: new Date("2026-05-30T11:00:00.000Z"),
    });
    orderQuery.findOne.mockResolvedValue({ id: 14, contract: { id: 56 } });
    const trxRaw = jest.fn().mockResolvedValue({ rows: [{ id: 14 }] });
    strapi.db.transaction.mockImplementationOnce(async (callback: any) => {
      return callback({ trx: { raw: trxRaw } });
    });
    contractQuery.update.mockResolvedValue({ id: 56 });
    orderLogQuery.create.mockResolvedValue({ id: 2 });
    mockedReleaseOrderReservation.mockResolvedValue({ success: true });

    const result = await runExpireStockReservationsTick(strapi, {
      now: new Date("2026-05-30T12:00:00.000Z"),
      graceSeconds: 0,
    });

    expect(result.status).toBe("completed");
    expect(result.stats.processed).toBe(1);
    expect(result.stats.skipped).toBe(0);
    expect(mockedReleaseOrderReservation).toHaveBeenCalled();
    // The reservation must not be pushed forward again.
    expect(orderQuery.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ReservedUntil: expect.anything() }),
      }),
    );
    expect(snappayOrchestrator.reconcileOrder).not.toHaveBeenCalled();
    expect(strapi.log.error).toHaveBeenCalledWith(
      "Releasing stock reservation for an unresolved SnappPay payment",
      expect.objectContaining({ reason: "parked_for_manual_review" }),
    );
    // The attempt is parked because the provider was unreadable, not because the
    // payment is known to have failed, so the order must survive: cancelling here
    // is what loses orders the customer already paid for.
    const cancelledOrder = trxRaw.mock.calls.some(([sql]: [string]) =>
      /UPDATE orders[\s\S]*Cancelled/i.test(String(sql)),
    );
    expect(cancelledOrder).toBe(false);
    expect(contractQuery.update).not.toHaveBeenCalled();
    expect(orderLogQuery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          Description: expect.stringContaining("operator review"),
        }),
      }),
    );
  });

  it("releases the reservation but does not cancel the order once an unresolved SnappPay attempt outlives the defer ceiling", async () => {
    const {
      strapi,
      orderQuery,
      contractQuery,
      orderLogQuery,
      paymentAttemptQuery,
      snappayOrchestrator,
    } = createMockStrapi();
    delete process.env.SNAPPAY_RESERVATION_DEFER_MAX_HOURS;
    strapi.entityService.findMany.mockResolvedValue([{ id: 15 }]);
    paymentAttemptQuery.findOne.mockResolvedValue({
      id: 115,
      attemptId: "snappay-attempt-15",
      Status: "Redirected",
      nextAction: "await_callback",
      nextActionAt: null,
      // 1h31m old — just past the 1.5h default ceiling.
      createdAt: new Date("2026-05-30T10:29:00.000Z"),
    });
    orderQuery.findOne.mockResolvedValue({ id: 15, contract: { id: 57 } });
    const trxRaw = jest.fn().mockResolvedValue({ rows: [{ id: 15 }] });
    strapi.db.transaction.mockImplementationOnce(async (callback: any) => {
      return callback({ trx: { raw: trxRaw } });
    });
    contractQuery.update.mockResolvedValue({ id: 57 });
    orderLogQuery.create.mockResolvedValue({ id: 3 });
    mockedReleaseOrderReservation.mockResolvedValue({ success: true });

    const result = await runExpireStockReservationsTick(strapi, {
      now: new Date("2026-05-30T12:00:00.000Z"),
      graceSeconds: 0,
    });

    expect(result.stats.processed).toBe(1);
    expect(mockedReleaseOrderReservation).toHaveBeenCalled();
    expect(snappayOrchestrator.reconcileOrder).not.toHaveBeenCalled();
    expect(strapi.log.error).toHaveBeenCalledWith(
      "Releasing stock reservation for an unresolved SnappPay payment",
      expect.objectContaining({ reason: "defer_ceiling_exceeded", deferCeilingHours: 1.5 }),
    );
    // Production evidence: every attempt that outlived the ceiling carried a
    // `status` 404/1007 that SnappPay's own panel still showed "در حال پردازش"
    // for — outliving the ceiling is not proof the payment failed, so this must
    // not cancel the order either, same as the parked-for-review case above.
    const cancelledOrder = trxRaw.mock.calls.some(([sql]: [string]) =>
      /UPDATE orders[\s\S]*Cancelled/i.test(String(sql)),
    );
    expect(cancelledOrder).toBe(false);
    expect(contractQuery.update).not.toHaveBeenCalled();
    expect(orderLogQuery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          Description: expect.stringContaining("operator review"),
        }),
      }),
    );
  });

  it("still defers an unresolved SnappPay attempt that is inside the 1.5h ceiling", async () => {
    const { strapi, orderQuery, paymentAttemptQuery, snappayOrchestrator } =
      createMockStrapi();
    delete process.env.SNAPPAY_RESERVATION_DEFER_MAX_HOURS;
    strapi.entityService.findMany.mockResolvedValue([{ id: 17 }]);
    paymentAttemptQuery.findOne.mockResolvedValue({
      id: 117,
      attemptId: "snappay-attempt-17",
      Status: "Redirected",
      nextAction: "await_callback",
      nextActionAt: null,
      // 1h29m old — inside the ceiling, so the reservation is pushed out again.
      createdAt: new Date("2026-05-30T10:31:00.000Z"),
    });
    orderQuery.update.mockResolvedValue({ id: 17 });

    const result = await runExpireStockReservationsTick(strapi, {
      now: new Date("2026-05-30T12:00:00.000Z"),
      graceSeconds: 0,
    });

    expect(result.stats.skipped).toBe(1);
    expect(result.stats.processed).toBe(0);
    expect(mockedReleaseOrderReservation).not.toHaveBeenCalled();
    expect(snappayOrchestrator.reconcileOrder).toHaveBeenCalledWith(
      17,
      "reservation_expiry",
    );
  });

  it("keeps deferring while the customer is still on the SnappPay payment page", async () => {
    const { strapi, orderQuery, paymentAttemptQuery, snappayOrchestrator } =
      createMockStrapi();
    strapi.entityService.findMany.mockResolvedValue([{ id: 16 }]);
    // await_callback carries a null nextActionAt, so the deferral must not key
    // on nextActionAt being set — that would release stock mid-payment.
    paymentAttemptQuery.findOne.mockResolvedValue({
      id: 116,
      attemptId: "snappay-attempt-16",
      Status: "Redirected",
      nextAction: "await_callback",
      nextActionAt: null,
      createdAt: new Date("2026-05-30T11:58:00.000Z"),
    });
    orderQuery.update.mockResolvedValue({ id: 16 });

    const result = await runExpireStockReservationsTick(strapi, {
      now: new Date("2026-05-30T12:00:00.000Z"),
      graceSeconds: 0,
    });

    expect(result.stats.skipped).toBe(1);
    expect(result.stats.processed).toBe(0);
    expect(mockedReleaseOrderReservation).not.toHaveBeenCalled();
    expect(snappayOrchestrator.reconcileOrder).toHaveBeenCalledWith(
      16,
      "reservation_expiry",
    );
  });

  it("skips overlapping stock-expiry runs in the same process", async () => {
    const { strapi } = createMockStrapi();
    let resolveFindMany: (value: unknown[]) => void = () => undefined;
    strapi.entityService.findMany.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveFindMany = resolve;
      })
    );

    const first = runExpireStockReservationsTick(strapi, {
      now: new Date("2026-05-30T12:00:00.000Z"),
      graceSeconds: 0,
    });
    await Promise.resolve();

    const second = await runExpireStockReservationsTick(strapi, {
      now: new Date("2026-05-30T12:00:01.000Z"),
      graceSeconds: 0,
    });

    expect(second.status).toBe("skipped");
    expect(second.status === "skipped" ? second.skippedReason : undefined).toBe("in_process");

    resolveFindMany([]);
    await first;
  });

  it("does not use the legacy DB lock for stock-expiry runs", async () => {
    process.env.DATABASE_CLIENT = "postgres";
    const { strapi } = createMockStrapi();
    strapi.entityService.findMany.mockResolvedValue([]);

    const result = await runExpireStockReservationsTick(strapi, {
      now: new Date("2026-05-30T12:00:00.000Z"),
      graceSeconds: 0,
    });

    expect(result.status).toBe("completed");
    const rawArgs = strapi.db.connection.raw.mock.calls.flat();
    expect(
      rawArgs.some(
        (argument) => typeof argument === "string" && argument.includes("background_job_locks")
      )
    ).toBe(false);
  });

  it("releases the in-process guard after DB errors", async () => {
    const { strapi } = createMockStrapi();
    strapi.entityService.findMany
      .mockRejectedValueOnce(new Error("db unavailable"))
      .mockResolvedValueOnce([]);

    await expect(
      runExpireStockReservationsTick(strapi, {
        now: new Date("2026-05-30T12:00:00.000Z"),
        graceSeconds: 0,
      }),
    ).rejects.toThrow("db unavailable");
    const recovered = await runExpireStockReservationsTick(strapi, {
      now: new Date("2026-05-30T12:00:01.000Z"),
      graceSeconds: 0,
    });

    expect(recovered.status).toBe("completed");
  });

  it("closes due reserve groups at group level with bounded batches", async () => {
    const { strapi } = createMockStrapi();
    const now = new Date("2026-05-30T12:00:00.000Z");
    strapi.db.connection.raw
      .mockResolvedValueOnce({
        rows: [
          { id: 1, groupKey: "group-a" },
          { id: 2, groupKey: "group-b" },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 2 }] });

    const result = await runExpireReserveOrdersTick(strapi, {
      now,
      batchSize: 2,
    });

    expect(result.status).toBe("completed");
    expect(result.stats.groupsProcessed).toBe(2);
    expect(strapi.db.connection.raw).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM reserve_groups"),
      ["Active", now, 2]
    );
  });

  it("never rewrites member orders when a window expires", async () => {
    // The admin list sorts by `updated_at` ("آخرین ویرایش") by default, so a
    // nightly expiry batch that touched member rows would read as a wave of
    // phantom staff edits. Expiry is a group-level transition only.
    const { strapi, orderQuery } = createMockStrapi();
    strapi.db.connection.raw
      .mockResolvedValueOnce({ rows: [{ id: 7, groupKey: "group-a" }] })
      .mockResolvedValueOnce({ rows: [{ id: 7 }] });

    const result = await runExpireReserveOrdersTick(strapi, {
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.status).toBe("completed");
    expect(result.stats.ordersUpdated).toBe(0);
    expect(orderQuery.update).not.toHaveBeenCalled();
    for (const call of strapi.db.connection.raw.mock.calls) {
      expect(String(call[0])).not.toMatch(/UPDATE\s+orders/i);
    }
  });

  it("is idempotent when another worker already closed the group", async () => {
    // The CAS guard on state = 'Active' is the cross-process anchor; the
    // in-process runner guard does not coordinate between containers.
    const { strapi } = createMockStrapi();
    strapi.db.connection.raw
      .mockResolvedValueOnce({ rows: [{ id: 3, groupKey: "group-c" }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await runExpireReserveOrdersTick(strapi, {
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.status).toBe("completed");
    expect(result.stats.groupsProcessed).toBe(0);
    expect(result.stats.skipped).toBe(1);
  });

  it("only closes groups whose deadline has actually passed", async () => {
    const { strapi } = createMockStrapi();
    const now = new Date("2026-05-30T12:00:00.000Z");
    strapi.db.connection.raw
      .mockResolvedValueOnce({ rows: [{ id: 9, groupKey: "group-d" }] })
      .mockResolvedValueOnce({ rows: [{ id: 9 }] });

    await runExpireReserveOrdersTick(strapi, { now });

    const updateSql = String(strapi.db.connection.raw.mock.calls[1][0]);
    expect(updateSql).toMatch(/UPDATE reserve_groups/);
    expect(updateSql).toMatch(/expires_at <= \?/);
    expect(strapi.db.connection.raw.mock.calls[1][1]).toContain("Expired");
  });

  it("skips reserve-order work when no expired groups exist", async () => {
    const { strapi } = createMockStrapi();
    strapi.db.connection.raw.mockResolvedValueOnce({ rows: [] });

    const result = await runExpireReserveOrdersTick(strapi, {
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.status).toBe("completed");
    expect(result.stats.groupsFound).toBe(0);
    expect(strapi.db.connection.raw).toHaveBeenCalledTimes(1);
  });

  it("skips overlapping reserve-order runs in the same process", async () => {
    const { strapi } = createMockStrapi();
    let resolveRaw: (value: { rows: unknown[] }) => void = () => undefined;
    strapi.db.connection.raw.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRaw = resolve;
      })
    );

    const first = runExpireReserveOrdersTick(strapi, {
      now: new Date("2026-05-30T12:00:00.000Z"),
    });
    await Promise.resolve();

    const second = await runExpireReserveOrdersTick(strapi, {
      now: new Date("2026-05-30T12:00:01.000Z"),
    });

    expect(second.status).toBe("skipped");
    expect(second.status === "skipped" ? second.skippedReason : undefined).toBe("in_process");

    resolveRaw({ rows: [] });
    await first;
  });
});
