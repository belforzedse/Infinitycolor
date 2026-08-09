import type { Strapi } from "@strapi/strapi";
import { runAnalyticsOutboxTick } from "../api/report/analytics/outbox";
import { type BackgroundJobStats, runBackgroundJob } from "./backgroundJobRunner";

const JOB_NAME = "analyticsOutboxRepair";

/**
 * Reconstructs missing settlement/refund events from commerce truth, then
 * delivers due rows with bounded retries. This job is intentionally independent
 * of payment requests and can be run on a worker-only process.
 */
export async function runAnalyticsOutboxRepairTick(
  strapi: Strapi,
  options: { limit?: number } = {},
) {
  return runBackgroundJob({
    strapi,
    jobName: JOB_NAME,
    run: async (): Promise<BackgroundJobStats> => runAnalyticsOutboxTick(strapi, options),
  });
}
