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

const safeJobId = (operationId: number, retryCount: number) =>
  `snappay-${operationId}-${retryCount}`;

export async function enqueueSnappayOperation(
  operationId: number,
  retryCount: number,
  delayMs = 0,
  settings: QueueSettings = getQueueSettings(),
): Promise<void> {
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
  try {
    await queue.add(
      SNAPPAY_PAYMENT_JOBS.operation,
      { operationId, retryCount },
      {
        jobId: safeJobId(operationId, retryCount),
        delay: Math.max(0, Math.round(delayMs)),
        attempts: 1,
      },
    );
  } finally {
    await queue.close();
  }
}
