import { Queue, type JobsOptions } from "bullmq";
import { type MaintenanceJobData, QUEUE_NAMES } from "./contracts";
import { getQueueSettings, toBullMqConnectionOptions, type QueueSettings } from "./env";

export const defaultMaintenanceJobOptions: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 30_000,
  },
  removeOnComplete: {
    age: 24 * 60 * 60,
    count: 1_000,
  },
  removeOnFail: {
    age: 7 * 24 * 60 * 60,
    count: 1_000,
  },
};

export function createMaintenanceQueues(settings: QueueSettings = getQueueSettings()) {
  const connection = toBullMqConnectionOptions(settings);
  const sharedOptions = {
    connection,
    prefix: settings.prefix,
    defaultJobOptions: defaultMaintenanceJobOptions,
  };

  return {
    commerce: new Queue<MaintenanceJobData, unknown, string>(
      QUEUE_NAMES.commerceMaintenance,
      sharedOptions
    ),
    analytics: new Queue<MaintenanceJobData, unknown, string>(
      QUEUE_NAMES.analyticsMaintenance,
      sharedOptions
    ),
  };
}

export type MaintenanceQueues = ReturnType<typeof createMaintenanceQueues>;
