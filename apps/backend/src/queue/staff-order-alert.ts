import { Queue } from "bullmq";
import {
  COMMERCE_MAINTENANCE_JOBS,
  QUEUE_NAMES,
  type StaffOrderAlertJobData,
} from "./contracts";
import { getQueueSettings, toBullMqConnectionOptions, type QueueSettings } from "./env";

const queueCache = new Map<string, Queue<StaffOrderAlertJobData, unknown, string>>();

/**
 * The enqueue fires from the order lifecycle, which runs inside the settlement
 * transaction. The delay gives that transaction time to commit before the
 * worker reads the row; if it still reads `Paying` the processor throws and the
 * retry schedule below takes over.
 */
const DEFAULT_DELAY_MS = 5_000;

function cacheKey(settings: QueueSettings): string {
  const connection = toBullMqConnectionOptions(settings) as Record<string, unknown>;
  return JSON.stringify([
    settings.prefix,
    connection.host ?? null,
    connection.port ?? null,
    connection.db ?? null,
    connection.username ?? null,
    connection.path ?? null,
  ]);
}

function getQueue(settings: QueueSettings) {
  const key = cacheKey(settings);
  const existing = queueCache.get(key);
  if (existing) return existing;
  const queue = new Queue<StaffOrderAlertJobData, unknown, string>(
    QUEUE_NAMES.commerceMaintenance,
    {
      connection: toBullMqConnectionOptions(settings),
      prefix: settings.prefix,
    },
  );
  queueCache.set(key, queue);
  return queue;
}

export async function enqueueStaffOrderStartedAlert(
  orderId: number,
  delayMs = DEFAULT_DELAY_MS,
  settings: QueueSettings = getQueueSettings(),
): Promise<void> {
  await getQueue(settings).add(
    COMMERCE_MAINTENANCE_JOBS.staffOrderAlert,
    { orderId },
    {
      // An order enters «در حال انجام» once. A stable id collapses the duplicate
      // enqueues a retried settlement callback would otherwise produce, and the
      // per-recipient Redis marker is the second line of defence.
      jobId: `staff-order-started-${orderId}`,
      delay: Math.max(0, Math.round(delayMs)),
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
    },
  );
}

export async function closeStaffOrderAlertQueues(): Promise<void> {
  const queues = [...queueCache.values()];
  queueCache.clear();
  await Promise.all(queues.map((queue) => queue.close().catch(() => undefined)));
}
