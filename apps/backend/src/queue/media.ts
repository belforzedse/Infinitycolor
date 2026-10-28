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

/**
 * BullMQ rejects a custom job id containing ":" unless it splits into exactly three
 * parts (a compatibility rule for old repeatable jobs), and rejects ids that are plain
 * integers. Every media id is therefore "-"-joined behind a text prefix. The ":" ids used
 * before this threw on every add, so no job was ever queued under them.
 */
export function mediaJobId(prefix: string, ...parts: Array<string | number>): string {
  return [prefix, ...parts.map((part) => String(part).replace(/:/g, "_"))].join("-");
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
      // Transcoding is expensive, so retries are few; inputs that cannot succeed (corrupt,
      // oversized, no ffmpeg) fail permanently on the first attempt (see runMediaJob).
      attempts: 3,
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
    { jobId: mediaJobId("normalize-story-video", storyId, itemHash, fileId) },
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
    { jobId: mediaJobId("normalize-product-video", fileId) },
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
    // same underlying work (the pipeline is a no-op once a file is processed, and a lease
    // keeps two workers from encoding it at once).
    { jobId: mediaJobId("normalize-uploaded-file", fileId) },
  );
}

/**
 * Re-check a file on behalf of an entity that references it (a post save today). The
 * upload-time job's id is already taken — and a failed job keeps it for a week — so this
 * uses its own id, bucketed per minute to absorb save bursts. The pipeline makes the
 * repeat cheap: a finished row is a single read.
 */
export async function enqueueVideoProcessingFor(
  fileId: number,
  context: string,
  settings: QueueSettings = getQueueSettings(),
  { force = false, webmEnabled, hlsEnabled }: { force?: boolean; webmEnabled?: boolean; hlsEnabled?: boolean } = {},
): Promise<void> {
  const bucket = Math.floor(Date.now() / 60_000);
  const safeContext = context.replace(/[^\w-]/g, "_").slice(0, 60);
  await getMediaQueue(settings).add(
    MEDIA_JOBS.normalizeUploadedFile,
    // `force` (backfill only) reprocesses rows the automatic triggers leave alone.
    { fileId, ...(force ? { force: true } : {}), ...(webmEnabled === undefined ? {} : { webmEnabled }), ...(hlsEnabled === undefined ? {} : { hlsEnabled }) },
    { jobId: mediaJobId("normalize-uploaded-file", fileId, safeContext, bucket) },
  );
}

/** Closes cached queue connections. For worker shutdown and tests. */
export async function closeMediaQueues(): Promise<void> {
  const queues = [...queueCache.values()];
  queueCache.clear();
  await Promise.all(queues.map((queue) => queue.close().catch(() => undefined)));
}
