import { Worker } from "bullmq";
import type { Strapi } from "@strapi/strapi";
import { QUEUE_NAMES } from "./contracts";
import { getQueueSettings, toBullMqConnectionOptions } from "./env";
import { processMaintenanceJob } from "./processors";
import { closeMediaQueues } from "./media";
import { closeSnappayQueues } from "./snappay";
import { closeAnipoRecipientQueues } from "./anipo-recipient";
import { closeAnipoRegistrationQueues } from "./anipo-registration";
import { closeStaffOrderAlertQueues } from "./staff-order-alert";
import { createLoadedStrapi } from "./strapi-instance";
import { terminateActiveMediaProcesses } from "../services/media/media-process";

/**
 * A media job BullMQ gave up on because its worker stopped responding (the container was
 * OOM-killed or restarted mid-encode) never reached the pipeline's own failure handling,
 * so the row would stay `processing` until its lease expired. Record it here.
 */
async function recordStalledMediaFailure(strapi: Strapi, job: any, error: Error | undefined) {
  if (!/stalled/i.test(error?.message ?? "")) return;
  const fileId = Number(job?.data?.fileId);
  if (!Number.isInteger(fileId) || fileId <= 0) return;
  try {
    const { recordAbandonedFailure } = await import("../services/media/video-metadata");
    await recordAbandonedFailure((strapi as any).db.connection, fileId, {
      stage: "worker",
      code: "stalled",
      message: "the worker stopped while processing this video",
      attempt: (job?.attemptsMade ?? 0) + 1,
      at: new Date().toISOString(),
      sourceUrl: null,
    }, job?.id ? String(job.id) : null);
  } catch (recordError) {
    strapi.log.warn(`[media] could not record stalled failure for file ${fileId}: ${(recordError as Error).message}`);
  }
}

type Closable = {
  close: () => Promise<void>;
};

async function closeAll(strapi: Strapi | undefined, workers: Closable[]) {
  await Promise.allSettled(workers.map((worker) => worker.close()));
  // The SnappPay producer keeps a cached queue connection open for reuse.
  await closeSnappayQueues().catch(() => undefined);
  await closeAnipoRecipientQueues().catch(() => undefined);
  await closeAnipoRegistrationQueues().catch(() => undefined);
  await closeStaffOrderAlertQueues().catch(() => undefined);
  await closeMediaQueues().catch(() => undefined);
  if (strapi && typeof (strapi as any).destroy === "function") {
    await (strapi as any).destroy();
  }
}

export async function startMaintenanceWorkers(): Promise<void> {
  const settings = getQueueSettings();
  const connection = toBullMqConnectionOptions(settings);
  const strapi = await createLoadedStrapi();

  const concurrencyByQueue: Record<string, number> = {
    [QUEUE_NAMES.commerceMaintenance]: settings.concurrency.commerce,
    [QUEUE_NAMES.analyticsMaintenance]: settings.concurrency.analytics,
    [QUEUE_NAMES.payments]: settings.concurrency.payments,
    [QUEUE_NAMES.media]: settings.concurrency.media,
  };

  const workers = settings.queues.map(
    (queueName) =>
      new Worker(queueName, (job, token) => processMaintenanceJob(strapi, job, token), {
        connection,
        prefix: settings.prefix,
        concurrency: concurrencyByQueue[queueName] ?? 1,
        // A transcode that takes the whole container down (OOM) shows up as a stall; one
        // extra recovery before failing covers a single unlucky restart.
        ...(queueName === QUEUE_NAMES.media ? { maxStalledCount: 2 } : {}),
      }),
  );

  for (const worker of workers) {
    worker.on("completed", (job) => {
      strapi.log.info("[BullMQ] maintenance job completed", {
        queue: job.queueName,
        jobId: job.id,
        name: job.name,
      });
    });
    worker.on("failed", (job, error) => {
      strapi.log.error(
        `[BullMQ] maintenance job failed queue=${job?.queueName} jobId=${job?.id} name=${job?.name}: ${error?.message}`,
      );
      if (job?.queueName === QUEUE_NAMES.media) {
        void recordStalledMediaFailure(strapi, job, error);
      }
    });
    worker.on("stalled", (jobId) => {
      strapi.log.warn("[BullMQ] maintenance job stalled", { jobId });
    });
    worker.on("error", (error) => {
      strapi.log.error("[BullMQ] worker error", error);
    });
  }

  const shutdown = async () => {
    // Stop encoders first so the interrupted job fails as `terminated` and is retried,
    // instead of ffmpeg outliving the worker and writing into the uploads volume.
    await terminateActiveMediaProcesses().catch(() => undefined);
    await closeAll(strapi, workers);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  // The Strapi logger drops metadata objects, so the detail goes in the message.
  strapi.log.info(
    `[BullMQ] maintenance workers ready queues=${settings.queues.join(",")} concurrency=${JSON.stringify(settings.concurrency)}`,
  );
}

if (require.main === module) {
  startMaintenanceWorkers().catch((error) => {
    console.error("[BullMQ] worker failed to start", error);
    process.exit(1);
  });
}
