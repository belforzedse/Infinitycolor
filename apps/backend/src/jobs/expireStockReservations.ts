import type { Strapi } from "@strapi/strapi";
import { releaseOrderReservation } from "../utils/stockReservations";
import { isSnappayAttemptParkedForReview } from "../api/payment-gateway/services/snappay-orchestrator";
import {
  type BackgroundJobStats,
  formatError,
  runBackgroundJob,
} from "./backgroundJobRunner";

const MAX_CONSECUTIVE_FAILURES = 5;
let consecutiveFailures = 0;
const JOB_NAME = "expireStockReservations";

/**
 * Hard ceiling on how long a single SnappPay attempt may keep deferring its stock
 * reservation. The reconciliation ladder in snappay-state-machine.ts totals ~40h,
 * so the default sits just past it: deferral must never outlive the recovery it
 * is waiting for. Beyond this the reservation is released even if the provider
 * state is still ambiguous — a paid-but-unreserved order is recoverable by an
 * operator, whereas stock held forever is not.
 */
const SNAPPAY_DEFER_CEILING_HOURS = Number(
  process.env.SNAPPAY_RESERVATION_DEFER_MAX_HOURS || 48,
);

const incrementMetric = (
  strapi: Strapi,
  name: string
) => {
  const metrics = (strapi as any).metrics;
  if (!metrics) return;
  if (typeof metrics.increment === "function") {
    metrics.increment(name);
    return;
  }
  if (typeof metrics.counter === "function") {
    const counter = metrics.counter(name);
    if (counter?.inc) {
      counter.inc();
      return;
    }
  }
  if (metrics?.counter?.inc) {
    metrics.counter.inc();
  }
};

type ExpireStockReservationsOptions = {
  batchSize?: number;
  now?: Date;
  graceSeconds?: number;
};

async function expireStockReservationsBatch(
  strapi: Strapi,
  options: Required<Pick<ExpireStockReservationsOptions, "batchSize" | "now" | "graceSeconds">>
): Promise<BackgroundJobStats> {
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let logsFailed = 0;
  const cutoff = new Date(options.now.getTime() - options.graceSeconds * 1000);

  const expiredOrders = (await strapi.entityService.findMany("api::order.order", {
    filters: {
      Status: "Paying",
      ReservationStatus: "Reserved",
      ReservedUntil: { $lt: cutoff },
    },
    fields: ["id"],
    limit: options.batchSize,
    sort: { ReservedUntil: "asc" },
  })) as any[];

  for (const o of expiredOrders || []) {
    const orderId = Number(o?.id);
    if (!Number.isFinite(orderId)) {
      skipped += 1;
      continue;
    }

    let shouldWriteExpiryLog = false;
    try {
      const activeSnappayAttempt: any = await strapi.db
        .query("api::payment-attempt.payment-attempt")
        .findOne({
          where: {
            order: { id: orderId },
            Gateway: "snappay",
            Status: { $in: ["Redirected", "Pending", "Unknown"] },
          },
        } as any);
      // Only defer while recovery is genuinely still going to happen.
      //
      // Keying this on the Status enum alone was a permanent inventory leak:
      // `markManualReview` parks an exhausted attempt as Status "Unknown" with
      // nextActionAt null, which is inside the {Redirected,Pending,Unknown} set
      // above, so the reservation was pushed out another 5 minutes every tick
      // forever while the reconcile enqueue silently no-opped and the operator
      // got a 409. Note we cannot key on `nextActionAt` being set either — a
      // customer sitting on the SnappPay payment page is "await_callback" with a
      // null nextActionAt, and releasing their stock mid-payment is worse still.
      const parkedForReview = isSnappayAttemptParkedForReview(activeSnappayAttempt);
      const attemptStartedAt = activeSnappayAttempt?.createdAt
        ? new Date(activeSnappayAttempt.createdAt).getTime()
        : null;
      const deferCeiling = SNAPPAY_DEFER_CEILING_HOURS * 60 * 60 * 1000;
      const exceededCeiling =
        attemptStartedAt !== null &&
        options.now.getTime() - attemptStartedAt > deferCeiling;

      if (activeSnappayAttempt && !parkedForReview && !exceededCeiling) {
        const extendedUntil = new Date(options.now.getTime() + 5 * 60 * 1000);
        await strapi.db.query("api::order.order").update({
          where: {
            id: orderId,
            Status: "Paying",
            ReservationStatus: "Reserved",
          },
          data: { ReservedUntil: extendedUntil },
        } as any);
        await strapi
          .service("api::payment-gateway.snappay-orchestrator")
          .reconcileOrder(orderId, "reservation_expiry")
          .catch((error: any) => {
            strapi.log.error(
              "Failed to enqueue SnappPay reconciliation during reservation expiry",
              {
                orderId,
                error: String(error?.message || error).slice(0, 300),
              },
            );
          });
        skipped += 1;
        strapi.log.warn(
          "Deferred reservation expiry for active SnappPay payment",
          {
            orderId,
            attemptId: activeSnappayAttempt.attemptId,
            paymentStatus: activeSnappayAttempt.Status,
            extendedUntil: extendedUntil.toISOString(),
          },
        );
        continue;
      }

      if (activeSnappayAttempt) {
        // Falling through to release. Surface it loudly: the money side of this
        // attempt is unresolved and now needs a human.
        incrementMetric(strapi, "snappay.reservation.released_unresolved");
        strapi.log.error(
          "Releasing stock reservation for an unresolved SnappPay payment",
          {
            orderId,
            attemptId: activeSnappayAttempt.attemptId,
            paymentStatus: activeSnappayAttempt.Status,
            nextAction: activeSnappayAttempt.nextAction || null,
            reason: parkedForReview ? "parked_for_manual_review" : "defer_ceiling_exceeded",
            deferCeilingHours: SNAPPAY_DEFER_CEILING_HOURS,
          },
        );
      }

      await strapi.db.transaction(async ({ trx }) => {
        const rel = await releaseOrderReservation(
          strapi as any,
          orderId,
          "Expired",
          trx,
          {
            requireOrderStatus: "Paying",
            expiresBefore: cutoff,
          }
        );
        if (rel.skipped) {
          skipped += 1;
          return;
        }
        if (!rel.success) {
          throw new Error(rel.error || "release_order_reservation_failed");
        }

        const order = await strapi.db.query("api::order.order").findOne({
          where: { id: orderId, Status: "Paying", ReservationStatus: "Expired" },
          populate: { contract: true },
          ...(trx ? { transacting: trx } : {}),
        });

        if (!order) {
          skipped += 1;
          return;
        }

        const orderCancelResult = await trx.raw(
          `UPDATE orders
           SET status = 'Cancelled'
           WHERE id = ?
             AND status = 'Paying'
             AND reservation_status = 'Expired'
           RETURNING id`,
          [orderId]
        );
        if ((orderCancelResult?.rows || []).length === 0) {
          skipped += 1;
          return;
        }

        const contractId =
          typeof order?.contract === "object" && order.contract
            ? Number(order.contract.id)
            : Number(order?.contract);
        if (Number.isFinite(contractId)) {
          await trx.raw(
            `UPDATE contracts
             SET status = 'Cancelled'
             WHERE id = ?`,
            [contractId]
          );
        }

        processed += 1;
        shouldWriteExpiryLog = true;
      });
    } catch (orderErr) {
      failed += 1;
      incrementMetric(strapi, "expire_stock_reservations_failures_total");
      strapi.log.error("expireStockReservations per-order transaction failed", {
        orderId,
        stage: "transaction",
        ...formatError(orderErr),
      });
      continue;
    }

    if (!shouldWriteExpiryLog) continue;

    try {
      await strapi.db.query("api::order-log.order-log").create({
        data: {
          order: orderId,
          Action: "Update",
          Description: "Reservation expired; order cancelled automatically",
          Changes: { ReservationStatus: "Expired" },
        },
      } as any);
    } catch (logErr) {
      logsFailed += 1;
      incrementMetric(strapi, "expire_stock_reservations_failures_total");
      strapi.log.error("Failed to create order-log for expired reservation", {
        orderId,
        stage: "post_commit_order_log",
        ...formatError(logErr),
      });
    }
  }

  return {
    scanned: expiredOrders?.length ?? 0,
    processed,
    skipped,
    failed,
    logsFailed,
    cutoff: cutoff.toISOString(),
  };
}

export async function runExpireStockReservationsTick(
  strapi: Strapi,
  options: ExpireStockReservationsOptions = {}
) {
  const batchSize = Math.max(
    1,
    Number(options.batchSize ?? process.env.STOCK_RESERVATION_EXPIRY_BATCH_SIZE ?? 100) || 100
  );
  const graceSeconds = Math.max(
    0,
    Number(
      options.graceSeconds ??
        process.env.STOCK_RESERVATION_EXPIRY_GRACE_SECONDS ??
        60
    ) || 0
  );
  const result = await runBackgroundJob({
    strapi,
    jobName: JOB_NAME,
    run: () =>
      expireStockReservationsBatch(strapi, {
        batchSize,
        graceSeconds,
        now: options.now ?? new Date(),
      }),
  });

  if (result.status === "completed") {
    const hadFailures = Number(result.stats.failed || 0) > 0 || Number(result.stats.logsFailed || 0) > 0;
    if (hadFailures) {
      consecutiveFailures += 1;
    } else {
      consecutiveFailures = 0;
    }
  } else if (result.status === "failed") {
    consecutiveFailures += 1;
    incrementMetric(strapi, "expire_stock_reservations_failures_total");
  }

  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    incrementMetric(strapi, "expire_stock_reservations_failure_threshold_total");
    strapi.log.warn("expireStockReservations consecutive failure threshold exceeded", {
      consecutiveFailures,
      threshold: MAX_CONSECUTIVE_FAILURES,
    });
  }

  return result;
}

export function startExpireStockReservationsJob(strapi: Strapi) {
  const enabled =
    String(process.env.ENABLE_STOCK_RESERVATION_EXPIRY_JOB || "true").toLowerCase() !== "false";
  if (!enabled) return;

  const intervalSeconds = Number(process.env.STOCK_RESERVATION_EXPIRY_JOB_INTERVAL_SECONDS || 60);
  const intervalMs = Math.max(10, Number.isFinite(intervalSeconds) ? intervalSeconds : 60) * 1000;

  const batchSize = Math.max(
    1,
    Number(process.env.STOCK_RESERVATION_EXPIRY_BATCH_SIZE || 100) || 100
  );

  const tick = async () => {
    await runExpireStockReservationsTick(strapi, { batchSize });
  };

  // Start shortly after boot, then every interval
  setTimeout(() => tick().catch(() => {}), 10_000);
  setInterval(() => tick().catch(() => {}), intervalMs);
}
