import type { Strapi } from "@strapi/strapi";
import { consumeCheckoutCartLines } from "../api/cart/services/lib/order-cart-cleanup";
import {
  type BackgroundJobStats,
  formatError,
  runBackgroundJob,
} from "./backgroundJobRunner";

const JOB_NAME = "reconcileCartCleanup";

/**
 * Retries post-payment cart cleanup that never completed.
 *
 * Cleanup runs outside the settlement transaction on purpose: a confirmed payment must
 * never be undone because a cart write failed. That makes it possible for a paid order to
 * be left with its cart lines unconsumed — after a crash between settlement and cleanup,
 * or a transient database error. `orders.CartCleanupCompletedAt` staying NULL is the
 * durable record of that, and this tick is what drains it, so the failure is retryable
 * rather than a log line nobody reads.
 *
 * `consumeCheckoutCartLines` claims the marker inside its own transaction, so this is
 * safe to run concurrently with a late in-request cleanup and safe to repeat.
 */

/**
 * Statuses that mean the customer actually paid, so the cart lines are owed consumption.
 * `Returned` is included deliberately: it is reachable from `Done`, so an order whose
 * cleanup failed and was then returned would otherwise be skipped by every later tick and
 * keep its stale cart lines forever. Consuming them then is still correct — the lines are
 * matched by their historical ids, so a line the customer has since changed or re-added no
 * longer matches and is left alone. `Cancelled` stays out: nothing was bought.
 */
const PAID_ORDER_STATUSES = ["Started", "Shipment", "Done", "Returned"];

type ReconcileCartCleanupOptions = {
  batchSize?: number;
  now?: Date;
  /** Grace period so an in-flight in-request cleanup is not raced needlessly. */
  graceSeconds?: number;
};

async function reconcileCartCleanupBatch(
  strapi: Strapi,
  options: Required<Pick<ReconcileCartCleanupOptions, "batchSize" | "now" | "graceSeconds">>,
): Promise<BackgroundJobStats> {
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const cutoff = new Date(options.now.getTime() - options.graceSeconds * 1000);

  const pending = (await strapi.db.query("api::order.order").findMany({
    where: {
      Status: { $in: PAID_ORDER_STATUSES },
      CartCleanupCompletedAt: { $null: true },
      updatedAt: { $lt: cutoff },
      // Only orders that recorded source-line identity are eligible. Orders created
      // before that column existed carry no cart linkage at all, so there is nothing to
      // consume and no reason to keep revisiting them.
      order_items: { SourceCartItemId: { $notNull: true } },
    },
    select: ["id"],
    orderBy: { updatedAt: "asc" },
    limit: options.batchSize,
  } as any)) as any[];

  for (const row of pending || []) {
    const orderId = Number(row?.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      skipped += 1;
      continue;
    }

    try {
      const outcome = await consumeCheckoutCartLines(strapi, orderId);
      if (outcome.status === "already_applied") {
        skipped += 1;
      } else {
        processed += 1;
        strapi.log.warn("Recovered cart cleanup for a paid order", { orderId, ...outcome });
      }
    } catch (error) {
      failed += 1;
      strapi.log.error("Cart cleanup reconciliation failed for order", {
        orderId,
        ...formatError(error),
      });
    }
  }

  return {
    scanned: pending?.length ?? 0,
    processed,
    skipped,
    failed,
    cutoff: cutoff.toISOString(),
  };
}

export async function runReconcileCartCleanupTick(
  strapi: Strapi,
  options: ReconcileCartCleanupOptions = {},
) {
  const batchSize = Math.max(
    1,
    Number(options.batchSize ?? process.env.CART_CLEANUP_RECONCILE_BATCH_SIZE ?? 100) || 100,
  );
  const graceSeconds = Math.max(
    0,
    Number(options.graceSeconds ?? process.env.CART_CLEANUP_RECONCILE_GRACE_SECONDS ?? 60) || 0,
  );

  return runBackgroundJob({
    strapi,
    jobName: JOB_NAME,
    run: () =>
      reconcileCartCleanupBatch(strapi, {
        batchSize,
        graceSeconds,
        now: options.now ?? new Date(),
      }),
  });
}

export function startReconcileCartCleanupJob(strapi: Strapi) {
  const enabled =
    String(process.env.ENABLE_CART_CLEANUP_RECONCILE_JOB || "true").toLowerCase() !== "false";
  if (!enabled) return;

  const intervalSeconds = Number(process.env.CART_CLEANUP_RECONCILE_INTERVAL_SECONDS || 300);
  const intervalMs =
    Math.max(30, Number.isFinite(intervalSeconds) ? intervalSeconds : 300) * 1000;

  const tick = async () => {
    await runReconcileCartCleanupTick(strapi);
  };

  setTimeout(() => tick().catch(() => {}), 30_000);
  setInterval(() => tick().catch(() => {}), intervalMs);
}
