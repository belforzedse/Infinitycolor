import type { Strapi } from "@strapi/strapi";
import * as PA from "../api/report/services/product-analytics";
import {
  getDailySalesRollupRows,
  getProductDailyRollupRows,
  upsertDailySalesRows,
  upsertProductDailyRows,
} from "../api/report/analytics/sources/commerce";
import {
  getRefreshState,
  markRunFailed,
  markRunStarted,
  markRunSucceeded,
} from "../api/report/analytics/sources/refreshState";
import { type BackgroundJobStats, formatError, runBackgroundJob } from "./backgroundJobRunner";

const JOB_NAME = "analyticsDailyRollup";
export const ANALYTICS_DAILY_ROLLUP_SOURCE_TYPE = "analytics_daily_rollup";

const ROLLUP_TIMEZONE = "Asia/Tehran";

/** Tehran-local calendar date (YYYY-MM-DD) for an instant. */
function tehranDateString(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ROLLUP_TIMEZONE }).format(date);
}

/** Calendar-date arithmetic on a YYYY-MM-DD string, timezone-agnostic by construction. */
function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

type AnalyticsDailyRollupOptions = {
  now?: Date;
  /** How many days back to seed on the very first run (no watermark yet). */
  initialLookbackDays?: number;
  /** Upper bound on days processed in a single tick — keeps the query and the upsert batch bounded. */
  maxDaysPerTick?: number;
};

async function runDailyRollupBatch(
  strapi: Strapi,
  options: Required<AnalyticsDailyRollupOptions>,
): Promise<BackgroundJobStats> {
  const knex = (strapi.db as any).connection;
  await markRunStarted(knex, ANALYTICS_DAILY_ROLLUP_SOURCE_TYPE);

  try {
    const todayStr = tehranDateString(options.now);
    const yesterdayStr = addDays(todayStr, -1);

    const state = await getRefreshState(knex, ANALYTICS_DAILY_ROLLUP_SOURCE_TYPE);
    const startDayStr = state?.watermark
      ? addDays(tehranDateString(state.watermark), 1)
      : addDays(yesterdayStr, -(options.initialLookbackDays - 1));

    const uncappedEndDayStr = addDays(startDayStr, options.maxDaysPerTick - 1);
    const endDayStr = uncappedEndDayStr < yesterdayStr ? uncappedEndDayStr : yesterdayStr;

    if (startDayStr > endDayStr) {
      await markRunSucceeded(
        knex,
        ANALYTICS_DAILY_ROLLUP_SOURCE_TYPE,
        state?.watermark ?? new Date(`${addDays(startDayStr, -1)}T00:00:00Z`),
      );
      return { processedDays: 0, reason: "up_to_date", watermark: state?.watermark?.toISOString() ?? null };
    }

    // Over-fetch by a full UTC day on each side to comfortably absorb Tehran's
    // +03:30 offset from UTC day boundaries; tzBucketExpr assigns the correct
    // Tehran-local day to each row inside the query, and we trim precisely below.
    const queryStart = new Date(`${addDays(startDayStr, -1)}T00:00:00Z`);
    const queryEnd = new Date(`${addDays(endDayStr, 1)}T23:59:59Z`);

    const joins = await PA.resolveJoins(knex);
    const [salesRows, productRows] = await Promise.all([
      getDailySalesRollupRows(knex, joins, queryStart, queryEnd),
      getProductDailyRollupRows(knex, joins, queryStart, queryEnd),
    ]);

    const inWindow = (bucketDate: string) => bucketDate >= startDayStr && bucketDate <= endDayStr;
    const trimmedSales = salesRows.filter((r) => inWindow(r.bucketDate));
    const trimmedProducts = productRows.filter((r) => inWindow(r.bucketDate));

    await upsertDailySalesRows(knex, trimmedSales);
    await upsertProductDailyRows(knex, trimmedProducts);

    const newWatermark = new Date(`${endDayStr}T00:00:00Z`);
    await markRunSucceeded(knex, ANALYTICS_DAILY_ROLLUP_SOURCE_TYPE, newWatermark);

    return {
      processedDays: dayCount(startDayStr, endDayStr),
      startDay: startDayStr,
      endDay: endDayStr,
      salesRowsWritten: trimmedSales.length,
      productRowsWritten: trimmedProducts.length,
      watermark: newWatermark.toISOString(),
    };
  } catch (error) {
    await markRunFailed(knex, ANALYTICS_DAILY_ROLLUP_SOURCE_TYPE, formatError(error).message).catch(
      () => {
        // If we can't even record the failure, the run's own thrown error below is
        // still surfaced by runBackgroundJob — this is a best-effort annotation.
      },
    );
    throw error;
  }
}

function dayCount(startDayStr: string, endDayStr: string): number {
  const start = new Date(`${startDayStr}T00:00:00Z`).getTime();
  const end = new Date(`${endDayStr}T00:00:00Z`).getTime();
  return Math.round((end - start) / 86_400_000) + 1;
}

export async function runAnalyticsDailyRollupTick(
  strapi: Strapi,
  options: AnalyticsDailyRollupOptions = {},
) {
  const resolved: Required<AnalyticsDailyRollupOptions> = {
    now: options.now ?? new Date(),
    initialLookbackDays: Math.max(
      1,
      Number(options.initialLookbackDays ?? process.env.ANALYTICS_ROLLUP_INITIAL_LOOKBACK_DAYS ?? 30) ||
        30,
    ),
    maxDaysPerTick: Math.max(
      1,
      Number(options.maxDaysPerTick ?? process.env.ANALYTICS_ROLLUP_MAX_DAYS_PER_TICK ?? 31) || 31,
    ),
  };

  return runBackgroundJob({
    strapi,
    jobName: JOB_NAME,
    run: () => runDailyRollupBatch(strapi, resolved),
  });
}
