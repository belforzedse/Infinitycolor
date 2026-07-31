import { Worker } from "bullmq";
import type { Strapi } from "@strapi/strapi";
import { QUEUE_NAMES } from "./contracts";
import { getQueueSettings, toBullMqConnectionOptions } from "./env";
import { processMaintenanceJob } from "./processors";
import { closeSnappayQueues } from "./snappay";
import { createLoadedStrapi } from "./strapi-instance";

type Closable = {
  close: () => Promise<void>;
};

async function closeAll(strapi: Strapi | undefined, workers: Closable[]) {
  await Promise.allSettled(workers.map((worker) => worker.close()));
  // The SnappPay producer keeps a cached queue connection open for reuse.
  await closeSnappayQueues().catch(() => undefined);
  if (strapi && typeof (strapi as any).destroy === "function") {
    await (strapi as any).destroy();
  }
}

export async function startMaintenanceWorkers(): Promise<void> {
  const settings = getQueueSettings();
  const connection = toBullMqConnectionOptions(settings);
  const strapi = await createLoadedStrapi();

  const workers = [
    new Worker(
      QUEUE_NAMES.commerceMaintenance,
      (job) => processMaintenanceJob(strapi, job),
      {
        connection,
        prefix: settings.prefix,
        concurrency: settings.concurrency.commerce,
      }
    ),
    new Worker(
      QUEUE_NAMES.analyticsMaintenance,
      (job) => processMaintenanceJob(strapi, job),
      {
        connection,
        prefix: settings.prefix,
        concurrency: settings.concurrency.analytics,
      }
    ),
    new Worker(
      QUEUE_NAMES.payments,
      (job) => processMaintenanceJob(strapi, job),
      {
        connection,
        prefix: settings.prefix,
        concurrency: settings.concurrency.payments,
      },
    ),
  ];

  for (const worker of workers) {
    worker.on("completed", (job) => {
      strapi.log.info("[BullMQ] maintenance job completed", {
        queue: job.queueName,
        jobId: job.id,
        name: job.name,
      });
    });
    worker.on("failed", (job, error) => {
      strapi.log.error("[BullMQ] maintenance job failed", {
        queue: job?.queueName,
        jobId: job?.id,
        name: job?.name,
        error,
      });
    });
    worker.on("stalled", (jobId) => {
      strapi.log.warn("[BullMQ] maintenance job stalled", { jobId });
    });
    worker.on("error", (error) => {
      strapi.log.error("[BullMQ] worker error", error);
    });
  }

  const shutdown = async () => {
    await closeAll(strapi, workers);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  strapi.log.info("[BullMQ] maintenance workers ready", {
    queues: Object.values(QUEUE_NAMES),
    concurrency: settings.concurrency,
  });
}

if (require.main === module) {
  startMaintenanceWorkers().catch((error) => {
    console.error("[BullMQ] worker failed to start", error);
    process.exit(1);
  });
}
