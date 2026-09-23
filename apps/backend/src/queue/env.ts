import type { ConnectionOptions } from "bullmq";
import { QUEUE_NAMES } from "./contracts";

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export type QueueSettings = {
  redisUrl: string;
  redisPassword?: string;
  prefix: string;
  timezone: string;
  /** Queues this worker process consumes. */
  queues: QueueName[];
  concurrency: {
    commerce: number;
    analytics: number;
    payments: number;
    media: number;
  };
  crons: {
    stockReservationExpiry: string;
    reserveOrderExpiry: string;
    scheduledProductPublish: string;
    cartCleanupReconcile: string;
    viewCounterFlush: string;
    analyticsDailyRollup: string;
    analyticsOutboxRepair: string;
    snappaySweep: string;
    walletTopupReconcile: string;
    anipoBarcodeReconcile: string;
  };
};

/**
 * `WORKER_QUEUES=media` runs a dedicated media worker; unset means every queue, which is
 * what the generic workers have always done. Unknown names are ignored, and a value that
 * names nothing valid falls back to all queues rather than starting an idle worker.
 */
export function readWorkerQueues(value: string | undefined): QueueName[] {
  const all = Object.values(QUEUE_NAMES) as QueueName[];
  if (!value?.trim()) return all;
  const requested = value
    .split(",")
    .map((name) => name.trim())
    .filter((name): name is QueueName => (all as string[]).includes(name));
  return requested.length ? [...new Set(requested)] : all;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

export function getQueueSettings(env: NodeJS.ProcessEnv = process.env): QueueSettings {
  return {
    redisUrl: env.QUEUE_REDIS_URL || "redis://localhost:6379",
    redisPassword: env.QUEUE_REDIS_PASSWORD || undefined,
    prefix: env.QUEUE_PREFIX || "bull:infinity",
    timezone: env.QUEUE_TIMEZONE || "Asia/Tehran",
    queues: readWorkerQueues(env.WORKER_QUEUES),
    concurrency: {
      commerce: readPositiveInt(env.WORKER_CONCURRENCY_COMMERCE, 1),
      analytics: readPositiveInt(env.WORKER_CONCURRENCY_ANALYTICS, 1),
      payments: readPositiveInt(env.WORKER_CONCURRENCY_PAYMENTS, 1),
      // Transcoding is CPU-bound and shares the host with the API replicas; one at a
      // time is deliberate.
      media: readPositiveInt(env.WORKER_CONCURRENCY_MEDIA, 1),
    },
    crons: {
      stockReservationExpiry: env.QUEUE_CRON_STOCK_RESERVATION_EXPIRY || "*/1 * * * *",
      reserveOrderExpiry: env.QUEUE_CRON_RESERVE_ORDER_EXPIRY || "*/5 * * * *",
      scheduledProductPublish: env.QUEUE_CRON_SCHEDULED_PRODUCT_PUBLISH || "*/1 * * * *",
      // Recovery-only: the in-request cleanup handles the normal case, so this just
      // drains paid orders whose cleanup never completed.
      cartCleanupReconcile: env.QUEUE_CRON_CART_CLEANUP_RECONCILE || "*/5 * * * *",
      viewCounterFlush: env.QUEUE_CRON_VIEW_COUNTER_FLUSH || "*/1 * * * *",
      // Once daily, well after Tehran midnight, so "yesterday" is a fully-closed
      // day before it is rolled up (see src/jobs/analyticsDailyRollup.ts).
      analyticsDailyRollup: env.QUEUE_CRON_ANALYTICS_DAILY_ROLLUP || "15 0 * * *",
      analyticsOutboxRepair: env.QUEUE_CRON_ANALYTICS_OUTBOX_REPAIR || "*/1 * * * *",
      snappaySweep: env.QUEUE_CRON_SNAPPAY_SWEEP || "*/1 * * * *",
      walletTopupReconcile:
        env.QUEUE_CRON_WALLET_TOPUP_RECONCILE || "*/1 * * * *",
      anipoBarcodeReconcile:
        env.QUEUE_CRON_ANIPO_BARCODE_RECONCILE || "*/15 * * * *",
    },
  };
}

export function toBullMqConnectionOptions(settings = getQueueSettings()): ConnectionOptions {
  const parsed = new URL(settings.redisUrl);
  const pathDb = parsed.pathname?.replace("/", "");
  const db = pathDb ? Number(pathDb) : undefined;
  const password =
    settings.redisPassword || (parsed.password ? decodeURIComponent(parsed.password) : undefined);

  return {
    host: parsed.hostname || "localhost",
    port: parsed.port ? Number(parsed.port) : 6379,
    db: Number.isInteger(db) && Number(db) >= 0 ? Number(db) : undefined,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(password ? { password } : {}),
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
