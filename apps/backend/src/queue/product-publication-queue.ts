import { Queue } from "bullmq";
import {
  COMMERCE_MAINTENANCE_JOBS,
  QUEUE_NAMES,
  type ScheduledProductPublicationJobData,
} from "./contracts";
import { getQueueSettings, toBullMqConnectionOptions } from "./env";

export function scheduledProductJobId(productId: number, scheduleRevision: number): string {
  return `product-publish-${productId}-${scheduleRevision}`;
}

function createQueue() {
  const settings = getQueueSettings();
  return new Queue<ScheduledProductPublicationJobData, unknown, string>(
    QUEUE_NAMES.commerceMaintenance,
    {
      connection: toBullMqConnectionOptions(settings),
      prefix: settings.prefix,
    },
  );
}

export async function enqueueScheduledProductPublication(
  data: ScheduledProductPublicationJobData,
): Promise<string> {
  const queue = createQueue();
  try {
    const delay = Math.max(0, Date.parse(data.expectedPublishAt) - Date.now());
    const job = await queue.add(COMMERCE_MAINTENANCE_JOBS.scheduledProductPublishOne, data, {
      jobId: scheduledProductJobId(data.productId, data.scheduleRevision),
      delay,
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
    });
    return String(job.id);
  } finally {
    await queue.close();
  }
}

export async function scheduledProductJobExists(
  productId: number,
  scheduleRevision: number,
): Promise<boolean> {
  const queue = createQueue();
  try {
    const job = await queue.getJob(scheduledProductJobId(productId, scheduleRevision));
    if (!job) return false;
    const state = await job.getState();
    if (state === "failed" || state === "completed" || state === "unknown") {
      await job.remove().catch(() => undefined);
      return false;
    }
    return true;
  } finally {
    await queue.close();
  }
}

export async function removeScheduledProductPublication(
  productId: number,
  scheduleRevision: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(scheduleRevision) || scheduleRevision <= 0) return false;
  const queue = createQueue();
  try {
    const job = await queue.getJob(scheduledProductJobId(productId, scheduleRevision));
    if (!job) return false;
    await job.remove();
    return true;
  } catch {
    // Removing an active job is expected to fail. Database revision/state is the
    // correctness boundary, so callers deliberately treat cleanup as best effort.
    return false;
  } finally {
    await queue.close();
  }
}
