import type { Strapi } from "@strapi/strapi";
import { releaseOrderReservation } from "../utils/stockReservations";
import { isSnappayAttemptParkedForReview } from "../api/payment-gateway/services/snappay-orchestrator";
import { markSnappayAttemptLocallyExpired } from "../api/payment-attempt/services/snappay-attempt-writes";
import { recordEvidence } from "../api/payment-attempt-evidence/services/evidence";
import { readPaymentAttemptLegs } from "../api/payment-attempt/services/payment-legs";
import { incrementMetric } from "../utils/metrics";
import {
  type BackgroundJobStats,
  formatError,
  runBackgroundJob,
} from "./backgroundJobRunner";

/**
 * How close the queued reconcile has to be before a deferral tick leaves it
 * alone.
 *
 * Every tick used to call `reconcileOrder`, which pulls the operation forward
 * to now. With a one-minute sweep that is up to ninety unscheduled runs inside
 * the 1.5-hour ceiling, each of which used to consume a retry slot — which is
 * why production attempts reach `RECONCILIATION_EXHAUSTED` after a median of
 * ten minutes instead of running the intended 5m/40m/3h/12h/24h ladder. A tick
 * now only intervenes when the ladder has genuinely left the attempt
 * unattended.
 */
const RECONCILE_PULL_THRESHOLD_MS = 10 * 60 * 1000;

const MAX_CONSECUTIVE_FAILURES = 5;
let consecutiveFailures = 0;
const JOB_NAME = "expireStockReservations";

/**
 * Hard ceiling on how long a single SnappPay attempt may keep deferring its stock
 * reservation. Beyond this the reservation is released even if the provider
 * state is still ambiguous — a paid-but-unreserved order is recoverable,
 * whereas stock held for hours on a checkout nobody paid for is not. Recovery
 * differs by path: a customer who returns hits the callback's reservation
 * check and is reverted; a settle reached only through reconciliation throws
 * SNAPPAY_LOCAL_STATE_CONFLICT after the provider has already settled and is
 * parked for an operator, who must cancel it on SnappPay's side.
 *
 * SnappPay publishes no payment-page or PENDING lifetime, so this is a bound we
 * chose, not one derived from the provider. 1.5h comfortably exceeds every
 * documented Iranian IPG session (Saman is 20 minutes) while keeping an
 * abandoned installment checkout from pinning inventory past lunchtime. The
 * earlier 48h default was sized to outlast the reconciliation ladder, which
 * traded stock availability for provider bookkeeping.
 */
const SNAPPAY_DEFER_CEILING_HOURS = Number(
  process.env.SNAPPAY_RESERVATION_DEFER_MAX_HOURS || 1.5,
);

/**
 * Is the queued reconcile for this attempt far enough away to be worth pulling?
 *
 * A missing or already-due operation answers "yes": the point is to make sure
 * something is going to happen, not to add another run on top of one that is
 * about to fire anyway.
 */
async function reconcileIsUnattended(
  strapi: Strapi,
  attemptId: number,
  now: Date,
): Promise<boolean> {
  try {
    const operation: any = await strapi.db
      .query("api::payment-operation.payment-operation")
      .findOne({
        where: {
          attemptKey: attemptId,
          OperationType: "RECONCILE",
          Status: { $in: ["Queued", "Processing"] },
        },
        orderBy: { nextRunAt: "asc" },
      } as any);
    if (!operation?.nextRunAt) return true;
    return new Date(operation.nextRunAt).getTime() - now.getTime() > RECONCILE_PULL_THRESHOLD_MS;
  } catch {
    return true;
  }
}

/**
 * Marks a swept SnappPay attempt terminal and records why, best-effort.
 *
 * Never throws: the release it describes has already committed, and there is
 * nothing useful to do with a failure here except report it.
 */
async function recordLocalExpiry(
  strapi: Strapi,
  input: { attempt: any; orderId: number; kind: "local_ttl" | "local_ceiling" },
): Promise<void> {
  try {
    const stamped = await markSnappayAttemptLocallyExpired(strapi as any, {
      attemptId: Number(input.attempt.id),
      reason: input.kind,
    });
    if (!stamped?.expired) return;
    const legs = readPaymentAttemptLegs(input.attempt);
    await recordEvidence(strapi as any, {
      attemptId: Number(input.attempt.id),
      orderId: input.orderId,
      kind: input.kind,
      // A local timeout is not a mode-gated decision: it records what happened,
      // and it happens identically whatever the recovery modes are set to.
      mode: "off",
      decision: "released",
      providerStatus: stamped.providerStatus,
      walletAmountIrr: legs.walletIrr,
      gatewayAmountIrr: legs.gatewayIrr,
      observedAt: new Date(),
      details: {
        reason:
          input.kind === "local_ttl" ? "parked_for_manual_review" : "defer_ceiling_exceeded",
        deferCeilingHours: SNAPPAY_DEFER_CEILING_HOURS,
      },
    });
  } catch (error: any) {
    strapi.log.error("Failed to record the local expiry of a SnappPay attempt", {
      attemptId: input.attempt?.attemptId,
      orderId: input.orderId,
      kind: input.kind,
      error: String(error?.message || error).slice(0, 300),
    });
  }
}

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

    let stage = "transaction";
    let cancelled = false;
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
        if (await reconcileIsUnattended(strapi, Number(activeSnappayAttempt.id), options.now)) {
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
        }
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
        if (rel.outcome === "skipped") {
          skipped += 1;
          return;
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

        // Reaching this line means the attempt was parked for review or outlived
        // the defer ceiling. Local cancel frees stock; it does not prove the
        // provider payment is terminal. Checkout must still refuse a second token
        // until GET /status shows a documented terminal state.
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

        stage = "order_log";
        await strapi.db.query("api::order-log.order-log").create({
          data: {
            order: orderId,
            Action: "Update",
            Description: "Reservation expired; order cancelled automatically",
            Changes: { ReservationStatus: "Expired" },
          },
          transacting: trx,
        } as any);
        processed += 1;
        cancelled = true;
      });

      // Deliberately after the commit, not inside it.
      //
      // Stamping the attempt terminal is what makes a late provider success
      // reachable at all: until now the sweep released the stock and cancelled
      // the order while leaving the attempt in an open `Unknown` state, so
      // nothing downstream could tell a timed-out checkout from one still in
      // flight and a shopper who paid afterwards had no handler.
      // `acceptSnappayCallback` now routes such a callback to the late-success
      // matrix, which is why the two changes ship together.
      //
      // It runs outside the transaction because a failed INSERT aborts a
      // PostgreSQL transaction outright: an audit row that could not be written
      // would take the stock release and the wallet release down with it, which
      // is precisely backwards. Losing the stamp costs nothing that matters —
      // the late-success routing also triggers on the order being `Cancelled`,
      // which this transaction has already committed.
      if (cancelled && activeSnappayAttempt?.id) {
        stage = "attempt_expiry";
        await recordLocalExpiry(strapi, {
          attempt: activeSnappayAttempt,
          orderId,
          kind: parkedForReview ? "local_ttl" : "local_ceiling",
        });
      }
    } catch (orderErr) {
      if ((orderErr as any)?.code === "MELLAT_PAYMENT_IN_PROGRESS") {
        skipped += 1;
        continue;
      }
      failed += 1;
      if (stage === "order_log") logsFailed += 1;
      incrementMetric(strapi, "expire_stock_reservations_failures_total");
      strapi.log.error("expireStockReservations per-order transaction failed", {
        orderId,
        stage,
        ...formatError(orderErr),
      });
      continue;
    }
  }

  if (failed > 0) {
    throw new Error(
      `expire_stock_reservations_batch_failed:${failed}:logs_failed:${logsFailed}`,
    );
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
  try {
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
    if (result.status === "completed") consecutiveFailures = 0;
    return result;
  } catch (error) {
    consecutiveFailures += 1;
    incrementMetric(strapi, "expire_stock_reservations_failures_total");
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      incrementMetric(strapi, "expire_stock_reservations_failure_threshold_total");
      strapi.log.warn("expireStockReservations consecutive failure threshold exceeded", {
        consecutiveFailures,
        threshold: MAX_CONSECUTIVE_FAILURES,
      });
    }
    throw error;
  }
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
