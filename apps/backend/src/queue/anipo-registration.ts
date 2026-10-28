import { Queue } from "bullmq";
import {
  COMMERCE_MAINTENANCE_JOBS,
  QUEUE_NAMES,
  type AnipoRegistrationJobData,
} from "./contracts";
import { getQueueSettings, toBullMqConnectionOptions, type QueueSettings } from "./env";

const queueCache = new Map<string, Queue<AnipoRegistrationJobData, unknown, string>>();

function getQueue(settings: QueueSettings) {
  const connection = toBullMqConnectionOptions(settings) as Record<string, unknown>;
  const key = JSON.stringify([
    settings.prefix,
    connection.host,
    connection.port,
    connection.db,
    connection.username,
    connection.path,
  ]);
  const existing = queueCache.get(key);
  if (existing) return existing;
  const queue = new Queue<AnipoRegistrationJobData, unknown, string>(
    QUEUE_NAMES.commerceMaintenance,
    { connection: toBullMqConnectionOptions(settings), prefix: settings.prefix },
  );
  queueCache.set(key, queue);
  return queue;
}

export async function enqueueAnipoRegistration(
  orderId: number,
  settings: QueueSettings = getQueueSettings(),
): Promise<void> {
  await getQueue(settings).add(
    COMMERCE_MAINTENANCE_JOBS.anipoRegisterOne,
    { orderId },
    {
      // A later 15-minute reconciliation can replace a retained failed/stalled
      // job, while same-window duplicate enqueues still collapse.
      jobId: `anipo-register-${orderId}-${Math.floor(Date.now() / (15 * 60_000))}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 60_000, jitter: 0.2 },
      removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
    },
  );
}

export async function closeAnipoRegistrationQueues(): Promise<void> {
  const queues = [...queueCache.values()];
  queueCache.clear();
  await Promise.all(queues.map((queue) => queue.close().catch(() => undefined)));
}
