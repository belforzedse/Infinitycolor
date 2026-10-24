import { Queue } from "bullmq";
import { getQueueSettings, toBullMqConnectionOptions } from "./env";
import { QUEUE_NAMES, MELLAT_PAYMENT_JOBS } from "./contracts";
import { defaultMaintenanceJobOptions } from "./queues";

let queue: Queue | undefined;

export async function enqueueMellatAttempt(attemptId: number, delayMs = 0): Promise<void> {
  const settings = getQueueSettings();
  queue ??= new Queue(QUEUE_NAMES.payments, {
    connection: toBullMqConnectionOptions(settings),
    prefix: settings.prefix,
    defaultJobOptions: { ...defaultMaintenanceJobOptions, attempts: 1 },
  });
  await queue.add(MELLAT_PAYMENT_JOBS.reconcile, { attemptId }, {
    // A completed job must not prevent the durable sweep from scheduling recovery.
    jobId: `mellat-${attemptId}-${Math.floor(Date.now() / 1000)}`,
    delay: Math.max(0, delayMs), attempts: 1,
  });
}

export async function closeMellatQueue(): Promise<void> {
  const current = queue;
  queue = undefined;
  await current?.close();
}
