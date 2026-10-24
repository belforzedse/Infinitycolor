import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
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
    // An active job must not deduplicate its own delayed retry. Database leases
    // fence concurrent deliveries from callbacks and the durable sweep.
    jobId: `mellat-${attemptId}-${randomUUID()}`,
    delay: Math.max(0, delayMs), attempts: 1,
  });
}

export async function closeMellatQueue(): Promise<void> {
  const current = queue;
  queue = undefined;
  await current?.close();
}
