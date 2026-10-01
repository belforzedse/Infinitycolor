import { createMaintenanceQueues } from "./queues";
import { getQueueSettings } from "./env";
import { registerMaintenanceSchedulers } from "./scheduler-registration";
import { initializeBackendSentry } from "../utils/sentry-initialization";

const REASSERT_INTERVAL_MS = 15 * 60 * 1000;
const HEALTH_LOG_INTERVAL_MS = 5 * 60 * 1000;

export async function startMaintenanceScheduler(): Promise<void> {
  const settings = getQueueSettings();
  const queues = createMaintenanceQueues(settings);

  const register = async () => {
    await registerMaintenanceSchedulers(queues, settings);
    console.info("[BullMQ] maintenance schedulers registered", {
      crons: settings.crons,
      timezone: settings.timezone,
    });
  };

  await register();

  const reassertTimer = setInterval(() => {
    register().catch((error) => {
      console.error("[BullMQ] failed to reassert maintenance schedulers", error);
    });
  }, REASSERT_INTERVAL_MS);

  const healthTimer = setInterval(async () => {
    try {
      const [commerceCounts, analyticsCounts, paymentCounts] = await Promise.all([
        queues.commerce.getJobCounts("waiting", "active", "delayed", "failed"),
        queues.analytics.getJobCounts("waiting", "active", "delayed", "failed"),
        queues.payments.getJobCounts("waiting", "active", "delayed", "failed"),
      ]);
      console.info("[BullMQ] maintenance queue health", {
        commerce: commerceCounts,
        analytics: analyticsCounts,
        payments: paymentCounts,
      });
    } catch (error) {
      console.error("[BullMQ] failed to read maintenance queue health", error);
    }
  }, HEALTH_LOG_INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(reassertTimer);
    clearInterval(healthTimer);
    await Promise.allSettled([
      queues.commerce.close(),
      queues.analytics.close(),
      queues.payments.close(),
    ]);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

if (require.main === module) {
  initializeBackendSentry();
  startMaintenanceScheduler().catch((error) => {
    console.error("[BullMQ] scheduler failed to start", error);
    process.exit(1);
  });
}
