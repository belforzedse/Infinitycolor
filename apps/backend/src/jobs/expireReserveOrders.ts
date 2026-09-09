import type { Strapi } from "@strapi/strapi";
import {
  type BackgroundJobStats,
  runBackgroundJob,
} from "./backgroundJobRunner";
import {
  auditSystemReserveEvent,
  closeGroup,
  RESERVE_CLOSURE_REASONS,
  RESERVE_GROUP_STATES,
} from "../api/reserve-group/lib/reserve-group";

const MAX_CONSECUTIVE_FAILURES = 5;
let consecutiveFailures = 0;
const JOB_NAME = "expireReserveOrders";

type ExpireReserveOrdersOptions = {
  batchSize?: number;
  now?: Date;
};

/**
 * Ends reserve windows whose 48h deadline has passed and hands the group to the
 * normal fulfillment workflow.
 *
 * Two deliberate properties:
 *
 * 1. It updates the `reserve_groups` row ONLY. Member orders are never touched,
 *    so their `updated_at` keeps meaning "a human changed this order" -- the admin
 *    list sorts by that column by default, and a nightly expiry batch must not
 *    surface as a wave of phantom staff edits.
 * 2. The transition is CAS-guarded on `state = 'Active'`, which is the
 *    cross-process idempotency anchor (backgroundJobRunner's guard is in-process
 *    only). Re-running a tick, or running several workers, converges.
 */
async function expireReserveGroupsBatch(
  strapi: Strapi,
  options: Required<Pick<ExpireReserveOrdersOptions, "batchSize" | "now">>
): Promise<BackgroundJobStats> {
  const dueRows = await strapi.db.connection.raw(
    `SELECT id, group_key AS "groupKey"
       FROM reserve_groups
      WHERE state = ?
        AND expires_at IS NOT NULL
        AND expires_at <= ?
      ORDER BY expires_at ASC
      LIMIT ?`,
    [RESERVE_GROUP_STATES.active, options.now, options.batchSize]
  );

  const groups = dueRows?.rows || [];
  let groupsProcessed = 0;
  let skipped = 0;

  for (const group of groups) {
    const groupId = Number(group?.id);
    if (!Number.isFinite(groupId)) {
      skipped += 1;
      continue;
    }

    const closed = await closeGroup(strapi, {
      groupId,
      reason: RESERVE_CLOSURE_REASONS.expired,
      now: options.now,
      requireExpired: true,
    });

    if (!closed) {
      // Someone released it early, or another worker got there first.
      skipped += 1;
      continue;
    }

    groupsProcessed += 1;

    await auditSystemReserveEvent(strapi, {
      eventKey: "orders.reserve_expired",
      group: { id: groupId, groupKey: String(group?.groupKey || "") },
      changes: [
        { field: "state", label: "وضعیت", from: "Active", to: "ReadyToFulfill" },
        { field: "closureReason", label: "دلیل پایان", from: null, to: "Expired" },
      ],
      metadata: { closedAt: options.now.toISOString() },
      dedupeKey: `reserve-expired:${groupId}`,
    });

    strapi.log.info("Reserve group window expired", {
      groupId,
      groupKey: group?.groupKey,
    });
  }

  return {
    groupsFound: groups.length,
    groupsProcessed,
    ordersUpdated: 0,
    skipped,
    cutoff: options.now.toISOString(),
  };
}

export async function runExpireReserveOrdersTick(
  strapi: Strapi,
  options: ExpireReserveOrdersOptions = {}
) {
  const batchSize = Math.max(
    1,
    Number(options.batchSize ?? process.env.RESERVE_ORDER_EXPIRY_BATCH_SIZE ?? 100) || 100
  );
  try {
    const result = await runBackgroundJob({
      strapi,
      jobName: JOB_NAME,
      run: () =>
        expireReserveGroupsBatch(strapi, {
          batchSize,
          now: options.now ?? new Date(),
        }),
    });
    if (result.status === "completed") consecutiveFailures = 0;
    return result;
  } catch (error) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      strapi.log.warn("expireReserveOrders consecutive failure threshold exceeded", {
        consecutiveFailures,
        threshold: MAX_CONSECUTIVE_FAILURES,
      });
    }
    throw error;
  }
}

/**
 * Moves expired reserve groups to ReadyToFulfill so admins can ship them.
 * Runs every 5-10 minutes.
 */
export function startExpireReserveOrdersJob(strapi: Strapi) {
  const enabled =
    String(process.env.ENABLE_RESERVE_ORDER_EXPIRY_JOB || "true").toLowerCase() !== "false";
  if (!enabled) return;

  const intervalMinutes = Number(process.env.RESERVE_ORDER_EXPIRY_JOB_INTERVAL_MINUTES || 5);
  const intervalMs = Math.max(1, Number.isFinite(intervalMinutes) ? intervalMinutes : 5) * 60 * 1000;

  const batchSize = Math.max(
    1,
    Number(process.env.RESERVE_ORDER_EXPIRY_BATCH_SIZE || 100) || 100
  );

  const tick = async () => {
    await runExpireReserveOrdersTick(strapi, { batchSize });
  };

  setTimeout(() => tick().catch(() => {}), 30_000);
  setInterval(() => tick().catch(() => {}), intervalMs);
}
