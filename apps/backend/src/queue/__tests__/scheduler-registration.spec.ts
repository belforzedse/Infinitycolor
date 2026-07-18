import {
  ANALYTICS_MAINTENANCE_JOBS,
  COMMERCE_MAINTENANCE_JOBS,
  MAINTENANCE_SCHEDULERS,
} from "../contracts";
import { getQueueSettings } from "../env";
import { registerMaintenanceSchedulers } from "../scheduler-registration";

describe("scheduler registration", () => {
  it("upserts all recurring maintenance jobs with stable scheduler ids", async () => {
    const commerceQueue = { upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };
    const analyticsQueue = { upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };

    await registerMaintenanceSchedulers(
      { commerce: commerceQueue as any, analytics: analyticsQueue as any },
      getQueueSettings({
        QUEUE_CRON_STOCK_RESERVATION_EXPIRY: "*/2 * * * *",
        QUEUE_CRON_RESERVE_ORDER_EXPIRY: "*/10 * * * *",
        QUEUE_CRON_VIEW_COUNTER_FLUSH: "*/3 * * * *",
        QUEUE_TIMEZONE: "Asia/Tehran",
      } as any)
    );

    expect(commerceQueue.upsertJobScheduler).toHaveBeenCalledWith(
      MAINTENANCE_SCHEDULERS.stockReservationExpiry,
      { pattern: "*/2 * * * *", tz: "Asia/Tehran" },
      expect.objectContaining({
        name: COMMERCE_MAINTENANCE_JOBS.stockReservationExpiry,
        data: {},
      })
    );
    expect(commerceQueue.upsertJobScheduler).toHaveBeenCalledWith(
      MAINTENANCE_SCHEDULERS.reserveOrderExpiry,
      { pattern: "*/10 * * * *", tz: "Asia/Tehran" },
      expect.objectContaining({
        name: COMMERCE_MAINTENANCE_JOBS.reserveOrderExpiry,
        data: {},
      })
    );
    expect(analyticsQueue.upsertJobScheduler).toHaveBeenCalledWith(
      MAINTENANCE_SCHEDULERS.viewCounterFlush,
      { pattern: "*/3 * * * *", tz: "Asia/Tehran" },
      expect.objectContaining({
        name: ANALYTICS_MAINTENANCE_JOBS.viewCounterFlush,
        data: {},
      })
    );
  });
});
