import type { ConnectionOptions } from "bullmq";

export type QueueSettings = {
  redisUrl: string;
  redisPassword?: string;
  prefix: string;
  timezone: string;
  concurrency: {
    commerce: number;
    analytics: number;
    payments: number;
  };
  crons: {
    stockReservationExpiry: string;
    reserveOrderExpiry: string;
    viewCounterFlush: string;
    analyticsDailyRollup: string;
    analyticsReconciliation: string;
    snappaySweep: string;
  };
};

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
    concurrency: {
      commerce: readPositiveInt(env.WORKER_CONCURRENCY_COMMERCE, 1),
      analytics: readPositiveInt(env.WORKER_CONCURRENCY_ANALYTICS, 1),
      payments: readPositiveInt(env.WORKER_CONCURRENCY_PAYMENTS, 1),
    },
    crons: {
      stockReservationExpiry: env.QUEUE_CRON_STOCK_RESERVATION_EXPIRY || "*/1 * * * *",
      reserveOrderExpiry: env.QUEUE_CRON_RESERVE_ORDER_EXPIRY || "*/5 * * * *",
      viewCounterFlush: env.QUEUE_CRON_VIEW_COUNTER_FLUSH || "*/1 * * * *",
      // Once daily, well after Tehran midnight, so "yesterday" is a fully-closed
      // day before it is rolled up (see src/jobs/analyticsDailyRollup.ts).
      analyticsDailyRollup: env.QUEUE_CRON_ANALYTICS_DAILY_ROLLUP || "15 0 * * *",
      // Staggered 30 min after the sales rollup so both jobs don't hit the DB
      // (and, for this one, the external Matomo host) at the same moment. Not
      // a hard dependency — reconciliation computes Strapi figures live via
      // SQL, not from the rollup table.
      analyticsReconciliation: env.QUEUE_CRON_ANALYTICS_RECONCILIATION || "45 0 * * *",
      snappaySweep: env.QUEUE_CRON_SNAPPAY_SWEEP || "*/1 * * * *",
    },
  };
}

export function toBullMqConnectionOptions(settings = getQueueSettings()): ConnectionOptions {
  const parsed = new URL(settings.redisUrl);
  const pathDb = parsed.pathname?.replace("/", "");
  const db = pathDb ? Number(pathDb) : undefined;
  const password =
    settings.redisPassword ||
    (parsed.password ? decodeURIComponent(parsed.password) : undefined);

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
