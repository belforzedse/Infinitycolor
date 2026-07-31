import {
  ANALYTICS_MAINTENANCE_JOBS,
  COMMERCE_MAINTENANCE_JOBS,
  MAINTENANCE_SCHEDULERS,
  SNAPPAY_PAYMENT_JOBS,
} from "./contracts";
import { defaultMaintenanceJobOptions, type MaintenanceQueues } from "./queues";
import type { QueueSettings } from "./env";

export async function registerMaintenanceSchedulers(
  queues: MaintenanceQueues,
  settings: QueueSettings
): Promise<void> {
  await queues.commerce.upsertJobScheduler(
    MAINTENANCE_SCHEDULERS.stockReservationExpiry,
    {
      pattern: settings.crons.stockReservationExpiry,
      tz: settings.timezone,
    },
    {
      name: COMMERCE_MAINTENANCE_JOBS.stockReservationExpiry,
      data: {},
      opts: defaultMaintenanceJobOptions,
    }
  );

  await queues.commerce.upsertJobScheduler(
    MAINTENANCE_SCHEDULERS.reserveOrderExpiry,
    {
      pattern: settings.crons.reserveOrderExpiry,
      tz: settings.timezone,
    },
    {
      name: COMMERCE_MAINTENANCE_JOBS.reserveOrderExpiry,
      data: {},
      opts: defaultMaintenanceJobOptions,
    }
  );

  await queues.analytics.upsertJobScheduler(
    MAINTENANCE_SCHEDULERS.viewCounterFlush,
    {
      pattern: settings.crons.viewCounterFlush,
      tz: settings.timezone,
    },
    {
      name: ANALYTICS_MAINTENANCE_JOBS.viewCounterFlush,
      data: {},
      opts: defaultMaintenanceJobOptions,
    }
  );

  await queues.payments.upsertJobScheduler(
    MAINTENANCE_SCHEDULERS.snappaySweep,
    {
      pattern: settings.crons.snappaySweep,
      tz: settings.timezone,
    },
    {
      name: SNAPPAY_PAYMENT_JOBS.sweep,
      data: {},
      opts: {
        ...defaultMaintenanceJobOptions,
        attempts: 1,
      },
    },
  );
}
