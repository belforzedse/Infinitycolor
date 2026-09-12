import { Queue } from "bullmq";
import {
  COMMERCE_MAINTENANCE_JOBS,
  QUEUE_NAMES,
  type AnipoRecipientSyncJobData,
} from "./contracts";
import { getQueueSettings, toBullMqConnectionOptions, type QueueSettings } from "./env";

const queueCache = new Map<string, Queue<AnipoRecipientSyncJobData, unknown, string>>();
const JOB_ID_BUCKET_MS = 60_000;

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
  const queue = new Queue<AnipoRecipientSyncJobData, unknown, string>(
    QUEUE_NAMES.commerceMaintenance,
    {
      connection: toBullMqConnectionOptions(settings),
      prefix: settings.prefix,
    },
  );
  queueCache.set(key, queue);
  return queue;
}

export async function enqueueAnipoRecipientSync(
  orderId: number,
  expectedRevision: number,
  delayMs = 0,
  settings: QueueSettings = getQueueSettings(),
): Promise<void> {
  await getQueue(settings).add(
    COMMERCE_MAINTENANCE_JOBS.anipoRecipientSyncOne,
    { orderId, expectedRevision },
    {
      // A failed job is retained for diagnosis. The minute bucket lets the
      // periodic reconciler enqueue the same durable revision again later while
      // still collapsing duplicate enqueue attempts in one sweep.
      jobId: `anipo-recipient-${orderId}-${expectedRevision}-${Math.floor(Date.now() / JOB_ID_BUCKET_MS)}`,
      delay: Math.max(0, Math.round(delayMs)),
      attempts: 5,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
    },
  );
}

export async function closeAnipoRecipientQueues(): Promise<void> {
  const queues = [...queueCache.values()];
  queueCache.clear();
  await Promise.all(queues.map((queue) => queue.close().catch(() => undefined)));
}
