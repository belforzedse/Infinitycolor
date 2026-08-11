import type { Strapi } from "@strapi/strapi";

const ERROR_STACK_LIMIT = 4_000;
const runningJobs = new Set<string>();

export type BackgroundJobStats = Record<string, number | string | boolean | null | undefined>;

export type BackgroundJobRunResult =
  | {
      status: "completed";
      durationMs: number;
      stats: BackgroundJobStats;
    }
  | {
      status: "skipped";
      durationMs: number;
      skippedReason: "in_process";
      stats: BackgroundJobStats;
    };

type RunBackgroundJobOptions = {
  strapi: Strapi;
  jobName: string;
  run: () => Promise<BackgroundJobStats>;
};

export function formatError(error: unknown) {
  const asRecord = (error && typeof error === "object" ? error : {}) as {
    message?: unknown;
    code?: unknown;
    stack?: unknown;
  };

  const message =
    typeof asRecord.message === "string"
      ? asRecord.message
      : error instanceof Error
        ? error.message
        : String(error);

  const code =
    typeof asRecord.code === "string" || typeof asRecord.code === "number"
      ? asRecord.code
      : undefined;

  const stack =
    typeof asRecord.stack === "string"
      ? asRecord.stack.slice(0, ERROR_STACK_LIMIT)
      : undefined;

  return { message, code, stack };
}

export async function runBackgroundJob({
  strapi,
  jobName,
  run,
}: RunBackgroundJobOptions): Promise<BackgroundJobRunResult> {
  const startedAt = Date.now();

  if (runningJobs.has(jobName)) {
    const result: BackgroundJobRunResult = {
      status: "skipped",
      skippedReason: "in_process",
      durationMs: 0,
      stats: { skipped: 1 },
    };
    strapi.log.info(`${jobName} job skipped`, result);
    return result;
  }

  runningJobs.add(jobName);

  try {
    const stats = await run();
    const result: BackgroundJobRunResult = {
      status: "completed",
      durationMs: Date.now() - startedAt,
      stats,
    };
    strapi.log.info(`${jobName} job completed`, result);
    return result;
  } catch (error) {
    const formatted = formatError(error);
    // Include the message in the headline: the logger drops the meta object in some
    // environments, which previously hid the root cause entirely.
    strapi.log.error(`${jobName} job failed: ${formatted.message}`, {
      durationMs: Date.now() - startedAt,
      error: formatted,
    });
    throw error instanceof Error ? error : new Error(formatted.message);
  } finally {
    runningJobs.delete(jobName);
  }
}

export function __resetBackgroundJobGuardsForTests() {
  runningJobs.clear();
}
