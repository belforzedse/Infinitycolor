import { Queue } from "bullmq";
import { createHash } from "node:crypto";
import {
  MEDIA_JOBS,
  QUEUE_NAMES,
  type MaintenanceJobData,
} from "./contracts";
import { getQueueSettings, toBullMqConnectionOptions, type QueueSettings } from "./env";
import { defaultMaintenanceJobOptions } from "./queues";

/**
 * Producer for the media queue. Follows the SnapPay producer's shape: a cached queue per
 * connection, because a request-time producer that built a new Queue per call would open
 * a Redis connection per story save.
 */
const queueCache = new Map<string, Queue<MaintenanceJobData, unknown, string>>();

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

function getMediaQueue(settings: QueueSettings): Queue<MaintenanceJobData, unknown, string> {
  const key = cacheKey(settings);
  const existing = queueCache.get(key);
  if (existing) return existing;

  const queue = new Queue<MaintenanceJobData, unknown, string>(QUEUE_NAMES.media, {
    connection: toBullMqConnectionOptions(settings),
    prefix: settings.prefix,
    defaultJobOptions: {
      ...defaultMaintenanceJobOptions,
      // Transcoding is expensive; two attempts rides out a transient filesystem or Redis
      // hiccup without re-encoding a broken file over and over.
      attempts: 2,
      backoff: { type: "exponential", delay: 120_000 },
    },
  });
  queueCache.set(key, queue);
  return queue;
}

export async function enqueueStoryVideoNormalization(
  storyId: number,
  itemKey: string,
  fileId: number,
  settings: QueueSettings = getQueueSettings(),
): Promise<void> {
  const itemHash = createHash("sha1").update(itemKey).digest("hex").slice(0, 12);
  await getMediaQueue(settings).add(
    MEDIA_JOBS.normalizeStoryVideo,
    { storyId, itemKey, fileId },
    // Per story/item/file: reordering does not duplicate work, while replacing media
    // creates a distinct job and a stale job can prove it no longer owns the item.
    { jobId: `normalize-story-video:${storyId}:${itemHash}:${fileId}` },
  );
}

export async function enqueueProductVideoNormalization(
  productId: number,
  fileId: number,
  settings: QueueSettings = getQueueSettings(),
): Promise<void> {
  await getMediaQueue(settings).add(
    MEDIA_JOBS.normalizeProductVideo,
    { productId, fileId },
    // Per-file so attaching a new clip after the first job completed still queues.
    { jobId: `normalize-product-video:${fileId}` },
  );
}

export async function enqueueUploadedFileNormalization(
  fileId: number,
  settings: QueueSettings = getQueueSettings(),
): Promise<void> {
  await getMediaQueue(settings).add(
    MEDIA_JOBS.normalizeUploadedFile,
    { fileId },
    // One job per raw file id; the product/story jobs above dedupe against this on the
    // same underlying work (`normalizeUploadFile` is a no-op once a file is already web-safe).
    { jobId: `normalize-uploaded-file:${fileId}` },
  );
}

/** Closes cached queue connections. For worker shutdown and tests. */
export async function closeMediaQueues(): Promise<void> {
  const queues = [...queueCache.values()];
  queueCache.clear();
  await Promise.all(queues.map((queue) => queue.close().catch(() => undefined)));
}
