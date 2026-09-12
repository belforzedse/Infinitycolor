import { Queue } from "bullmq";
import {
  COMMERCE_MAINTENANCE_JOBS,
  QUEUE_NAMES,
  type EdgeCachePurgeJobData,
} from "./contracts";
import { getQueueSettings, toBullMqConnectionOptions, type QueueSettings } from "./env";

const queueCache = new Map<string, Queue<EdgeCachePurgeJobData, unknown, string>>();

/**
 * Editing a product fires several lifecycles in a row, and a bulk price update
 * fires hundreds within a second. Bucketing the job id collapses that burst into
 * one purge per product per window, and the short delay gives the writes time to
 * settle so the re-render reads the finished state rather than a half-applied one.
 */
const JOB_ID_BUCKET_MS = 2_000;
const ENQUEUE_DELAY_MS = 2_000;

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
  const queue = new Queue<EdgeCachePurgeJobData, unknown, string>(
    QUEUE_NAMES.commerceMaintenance,
    {
      connection: toBullMqConnectionOptions(settings),
      prefix: settings.prefix,
    },
  );
  queueCache.set(key, queue);
  return queue;
}

export async function enqueueEdgeCachePurge(
  data: EdgeCachePurgeJobData,
  options: { dedupeKey?: string; settings?: QueueSettings } = {},
): Promise<void> {
  if (!data.paths || data.paths.length === 0) return;

  const settings = options.settings ?? getQueueSettings();
  const bucket = Math.floor(Date.now() / JOB_ID_BUCKET_MS);
  const dedupeKey = options.dedupeKey ?? data.kind;

  await getQueue(settings).add(COMMERCE_MAINTENANCE_JOBS.edgeCachePurge, data, {
    jobId: `edge-${dedupeKey}-${bucket}`,
    delay: ENQUEUE_DELAY_MS,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { age: 6 * 60 * 60, count: 500 },
    removeOnFail: { age: 24 * 60 * 60, count: 500 },
  });
}

export async function closeEdgeCacheQueues(): Promise<void> {
  const queues = [...queueCache.values()];
  queueCache.clear();
  await Promise.all(queues.map((queue) => queue.close().catch(() => undefined)));
}
