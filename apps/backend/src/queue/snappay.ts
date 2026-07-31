import { Queue } from "bullmq";
import {
  QUEUE_NAMES,
  SNAPPAY_PAYMENT_JOBS,
  type MaintenanceJobData,
} from "./contracts";
import {
  getQueueSettings,
  toBullMqConnectionOptions,
  type QueueSettings,
} from "./env";
import { defaultMaintenanceJobOptions } from "./queues";

/**
 * Coarse time bucket mixed into the BullMQ job id.
 *
 * BullMQ silently no-ops `add()` for a jobId that already exists, and completed
 * jobs are retained for 24h. The id used to be `snappay-{op}-{retryCount}`, which
 * meant a job that finished without changing `retryCount` — e.g. the CAS in
 * `claimSnappayOperation` finding the row not yet due because of a small clock
 * skew — burned that id for a full day. The sweep then re-added the identical id
 * every minute, each call resolving successfully while queueing nothing, and the
 * operation sat stranded for 24 hours.
 *
 * A minute bucket keeps the useful part of deduplication (a sweep firing
 * repeatedly inside the same minute still collapses to one job) without letting a
 * spent id block progress forever. Correctness does not rest on this: the durable
 * at-most-once guarantee is the compare-and-set claim on `payment_operations`, so
 * an extra queued job simply loses the claim and exits.
 */
const JOB_ID_BUCKET_MS = 60_000;

const safeJobId = (operationId: number, retryCount: number, now: number) =>
  `snappay-${operationId}-${retryCount}-${Math.floor(now / JOB_ID_BUCKET_MS)}`;

/**
 * Cached queue handles, keyed by connection settings.
 *
 * Previously a `new Queue(...)` was constructed and closed on every call, so each
 * callback, retry schedule and swept row paid a full Redis connection setup and
 * teardown — up to 100 times per minute inside the sweep loop alone.
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

function getPaymentsQueue(settings: QueueSettings) {
  const key = cacheKey(settings);
  const existing = queueCache.get(key);
  if (existing) return existing;

  const queue = new Queue<MaintenanceJobData, unknown, string>(
    QUEUE_NAMES.payments,
    {
      connection: toBullMqConnectionOptions(settings),
      prefix: settings.prefix,
      defaultJobOptions: {
        ...defaultMaintenanceJobOptions,
        attempts: 1,
      },
    },
  );
  queueCache.set(key, queue);
  return queue;
}

export async function enqueueSnappayOperation(
  operationId: number,
  retryCount: number,
  delayMs = 0,
  settings: QueueSettings = getQueueSettings(),
): Promise<void> {
  const queue = getPaymentsQueue(settings);
  await queue.add(
    SNAPPAY_PAYMENT_JOBS.operation,
    { operationId, retryCount },
    {
      jobId: safeJobId(operationId, retryCount, Date.now()),
      delay: Math.max(0, Math.round(delayMs)),
      attempts: 1,
    },
  );
}

/** Closes cached queue connections. For worker shutdown and tests. */
export async function closeSnappayQueues(): Promise<void> {
  const queues = [...queueCache.values()];
  queueCache.clear();
  await Promise.all(queues.map((queue) => queue.close().catch(() => undefined)));
}
