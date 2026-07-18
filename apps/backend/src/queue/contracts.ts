export const QUEUE_NAMES = {
  commerceMaintenance: "commerce-maintenance",
  analyticsMaintenance: "analytics-maintenance",
} as const;

export const COMMERCE_MAINTENANCE_JOBS = {
  stockReservationExpiry: "stockReservations.expire",
  reserveOrderExpiry: "reserveOrders.expire",
} as const;

export const ANALYTICS_MAINTENANCE_JOBS = {
  viewCounterFlush: "viewCounters.flush",
} as const;

export const MAINTENANCE_SCHEDULERS = {
  stockReservationExpiry: "sched:stockReservations.expire",
  reserveOrderExpiry: "sched:reserveOrders.expire",
  viewCounterFlush: "sched:viewCounters.flush",
} as const;

export type CommerceMaintenanceJobName =
  (typeof COMMERCE_MAINTENANCE_JOBS)[keyof typeof COMMERCE_MAINTENANCE_JOBS];

export type AnalyticsMaintenanceJobName =
  (typeof ANALYTICS_MAINTENANCE_JOBS)[keyof typeof ANALYTICS_MAINTENANCE_JOBS];

export type MaintenanceJobName = CommerceMaintenanceJobName | AnalyticsMaintenanceJobName;

export type MaintenanceJobData = Record<string, never>;
