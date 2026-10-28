import { createMaintenanceQueues, type MaintenanceQueues } from "./queues";
import { getQueueSettings } from "./env";
import { registerMaintenanceSchedulers } from "./scheduler-registration";
import { initializeBackendSentry } from "../utils/sentry-initialization";
import {
  startBackgroundReadiness,
  redisResponds,
  type BackgroundProcess,
} from "./readiness";

const REASSERT_INTERVAL_MS = 15 * 60 * 1000;
const HEALTH_LOG_INTERVAL_MS = 5 * 60 * 1000;

export async function startMaintenanceScheduler(): Promise<BackgroundProcess> {
  const settings = getQueueSettings();
  let queues: MaintenanceQueues;
  const allQueues: MaintenanceQueues[keyof MaintenanceQueues][] = [];
  let stopping = false;
  let registration: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let reassertTimer: NodeJS.Timeout | undefined;
  let healthTimer: NodeJS.Timeout | undefined;
  let removeSignalHandlers = () => {};

  const readiness = await startBackgroundReadiness(async () => {
    if (
      stopping ||
      allQueues.length !== 3 ||
      allQueues.some((queue) => queue.closing)
    )
      return false;
    return (
      await Promise.all(
        allQueues.map(async (queue) => redisResponds(await queue.client)),
      )
    ).every(Boolean);
  });

  const register = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (registration) return registration;
    registration = registerMaintenanceSchedulers(queues, settings)
      .then(() => {
        if (!stopping) readiness.markReady();
        console.info("[BullMQ] maintenance schedulers registered", {
          crons: settings.crons,
          timezone: settings.timezone,
        });
      })
      .catch((error) => {
        readiness.markUnready();
        throw error;
      })
      .finally(() => {
        registration = undefined;
      });
    return registration;
  };

  const close = () => {
    stopping = true;
    readiness.markUnready();
    if (!closing) {
      removeSignalHandlers();
      if (reassertTimer) clearInterval(reassertTimer);
      if (healthTimer) clearInterval(healthTimer);
      closing = (async () => {
        try {
          // Do not close clients beneath a registration or allow it to restore readiness.
          await registration?.catch(() => undefined);
          await Promise.allSettled(allQueues.map((queue) => queue.close()));
        } finally {
          await readiness.close();
        }
      })();
    }
    return closing;
  };

  const shutdown = () => {
    void close().then(
      () => process.exit(0),
      (error) => {
        console.error("[BullMQ] scheduler shutdown failed", error);
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  removeSignalHandlers = () => {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  };

  try {
    queues = createMaintenanceQueues(settings);
    allQueues.push(queues.commerce, queues.analytics, queues.payments);
    for (const queue of allQueues) {
      queue.on("error", (error) =>
        console.error("[BullMQ] scheduler queue error", error),
      );
    }
    await Promise.all(allQueues.map((queue) => queue.waitUntilReady()));
    if (stopping) {
      await closing;
      return { close };
    }
    await register();
    if (stopping) {
      await closing;
      return { close };
    }

    reassertTimer = setInterval(() => {
      register().catch((error) => {
        console.error(
          "[BullMQ] failed to reassert maintenance schedulers",
          error,
        );
      });
    }, REASSERT_INTERVAL_MS);

    healthTimer = setInterval(async () => {
      try {
        const [commerceCounts, analyticsCounts, paymentCounts] =
          await Promise.all([
            queues.commerce.getJobCounts(
              "waiting",
              "active",
              "delayed",
              "failed",
            ),
            queues.analytics.getJobCounts(
              "waiting",
              "active",
              "delayed",
              "failed",
            ),
            queues.payments.getJobCounts(
              "waiting",
              "active",
              "delayed",
              "failed",
            ),
          ]);
        console.info("[BullMQ] maintenance queue health", {
          commerce: commerceCounts,
          analytics: analyticsCounts,
          payments: paymentCounts,
        });
      } catch (error) {
        console.error(
          "[BullMQ] failed to read maintenance queue health",
          error,
        );
      }
    }, HEALTH_LOG_INTERVAL_MS);

    return { close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

if (require.main === module) {
  initializeBackendSentry();
  startMaintenanceScheduler().catch((error) => {
    console.error("[BullMQ] scheduler failed to start", error);
    process.exit(1);
  });
}
