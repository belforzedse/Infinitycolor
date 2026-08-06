import type { Strapi } from "@strapi/strapi";
import * as PA from "../api/report/services/product-analytics";
import {
  reconcileCommerceWindow,
  upsertReconciliationRow,
} from "../api/report/analytics/reconcile/commerceReconciliation";
import {
  getRefreshState,
  markRunFailed,
  markRunStarted,
  markRunSucceeded,
} from "../api/report/analytics/sources/refreshState";
import { type BackgroundJobStats, formatError, runBackgroundJob } from "./backgroundJobRunner";

const JOB_NAME = "analyticsReconciliation";
export const ANALYTICS_RECONCILIATION_SOURCE_TYPE = "analytics_reconciliation";

const RECONCILIATION_TIMEZONE = "Asia/Tehran";

/** Tehran-local calendar date (YYYY-MM-DD) for an instant. */
function tehranDateString(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: RECONCILIATION_TIMEZONE }).format(date);
}

/** Calendar-date arithmetic on a YYYY-MM-DD string, timezone-agnostic by construction. */
function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

type AnalyticsReconciliationOptions = {
  now?: Date;
  /** How many days back to seed on the very first run (no watermark yet). Kept
   * small by default — this is a health check, not a backfill, and each day
   * costs one live Matomo API call. */
  initialLookbackDays?: number;
  /** Upper bound on days processed in a single tick — bounds Matomo API calls per tick. */
  maxDaysPerTick?: number;
};

async function runReconciliationBatch(
  strapi: Strapi,
  options: Required<AnalyticsReconciliationOptions>,
): Promise<BackgroundJobStats> {
  const knex = (strapi.db as any).connection;
  await markRunStarted(knex, ANALYTICS_RECONCILIATION_SOURCE_TYPE);

  try {
    const todayStr = tehranDateString(options.now);
    const yesterdayStr = addDays(todayStr, -1);

    const state = await getRefreshState(knex, ANALYTICS_RECONCILIATION_SOURCE_TYPE);
    const startDayStr = state?.watermark
      ? addDays(tehranDateString(state.watermark), 1)
      : addDays(yesterdayStr, -(options.initialLookbackDays - 1));

    const uncappedEndDayStr = addDays(startDayStr, options.maxDaysPerTick - 1);
    const endDayStr = uncappedEndDayStr < yesterdayStr ? uncappedEndDayStr : yesterdayStr;

    if (startDayStr > endDayStr) {
      await markRunSucceeded(
        knex,
        ANALYTICS_RECONCILIATION_SOURCE_TYPE,
        state?.watermark ?? new Date(`${addDays(startDayStr, -1)}T00:00:00Z`),
      );
      return {
        processedDays: 0,
        reason: "up_to_date",
        watermark: state?.watermark?.toISOString() ?? null,
      };
    }

    const joins = await PA.resolveJoins(knex);
    let matchedCount = 0;
    let divergedCount = 0;
    let unavailableCount = 0;
    let mismatchCount = 0;

    // One Matomo call per day (Goals.get returns a single window aggregate, not a
    // per-day breakdown when filtered to idGoal=ecommerceOrder) — sequential, not
    // parallel, to stay a polite, low-concurrency caller of the shared Matomo host.
    for (let day = startDayStr; day <= endDayStr; day = addDays(day, 1)) {
      const dayStart = new Date(`${day}T00:00:00Z`);
      const dayEnd = new Date(`${day}T23:59:59Z`);
      const result = await reconcileCommerceWindow(knex, joins, dayStart, dayEnd);
      await upsertReconciliationRow(knex, day, result);
      if (result.status === "matched") matchedCount += 1;
      else if (result.status === "diverged") divergedCount += 1;
      else unavailableCount += 1;
      if (result.possibleCurrencyMismatch) mismatchCount += 1;
    }

    const newWatermark = new Date(`${endDayStr}T00:00:00Z`);
    await markRunSucceeded(knex, ANALYTICS_RECONCILIATION_SOURCE_TYPE, newWatermark);

    if (mismatchCount > 0) {
      strapi.log?.warn?.("[analyticsReconciliation] possible currency mismatch detected", {
        startDay: startDayStr,
        endDay: endDayStr,
        mismatchCount,
      });
    }

    return {
      processedDays: dayCount(startDayStr, endDayStr),
      startDay: startDayStr,
      endDay: endDayStr,
      matchedDays: matchedCount,
      divergedDays: divergedCount,
      matomoUnavailableDays: unavailableCount,
      possibleCurrencyMismatchDays: mismatchCount,
      watermark: newWatermark.toISOString(),
    };
  } catch (error) {
    await markRunFailed(
      knex,
      ANALYTICS_RECONCILIATION_SOURCE_TYPE,
      formatError(error).message,
    ).catch(() => {
      // Best-effort annotation — runBackgroundJob still surfaces the thrown error.
    });
    throw error;
  }
}

function dayCount(startDayStr: string, endDayStr: string): number {
  const start = new Date(`${startDayStr}T00:00:00Z`).getTime();
  const end = new Date(`${endDayStr}T00:00:00Z`).getTime();
  return Math.round((end - start) / 86_400_000) + 1;
}

export async function runAnalyticsReconciliationTick(
  strapi: Strapi,
  options: AnalyticsReconciliationOptions = {},
) {
  const resolved: Required<AnalyticsReconciliationOptions> = {
    now: options.now ?? new Date(),
    initialLookbackDays: Math.max(
      1,
      Number(
        options.initialLookbackDays ?? process.env.ANALYTICS_RECONCILIATION_INITIAL_LOOKBACK_DAYS ?? 7,
      ) || 7,
    ),
    maxDaysPerTick: Math.max(
      1,
      Number(options.maxDaysPerTick ?? process.env.ANALYTICS_RECONCILIATION_MAX_DAYS_PER_TICK ?? 7) ||
        7,
    ),
  };

  return runBackgroundJob({
    strapi,
    jobName: JOB_NAME,
    run: () => runReconciliationBatch(strapi, resolved),
  });
}
