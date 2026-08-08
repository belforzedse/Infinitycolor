export const QUEUE_NAMES = {
  commerceMaintenance: "commerce-maintenance",
  analyticsMaintenance: "analytics-maintenance",
  payments: "payments",
} as const;

export const COMMERCE_MAINTENANCE_JOBS = {
  stockReservationExpiry: "stockReservations.expire",
  reserveOrderExpiry: "reserveOrders.expire",
  scheduledProductPublish: "scheduledProducts.publish",
} as const;

export const ANALYTICS_MAINTENANCE_JOBS = {
  viewCounterFlush: "viewCounters.flush",
  analyticsDailyRollup: "analyticsDailyRollup.run",
  analyticsReconciliation: "analyticsReconciliation.run",
} as const;

export const SNAPPAY_PAYMENT_JOBS = {
  operation: "snappay.operation",
  sweep: "snappay.sweep",
} as const;

export const MAINTENANCE_SCHEDULERS = {
  stockReservationExpiry: "sched:stockReservations.expire",
  reserveOrderExpiry: "sched:reserveOrders.expire",
  scheduledProductPublish: "sched:scheduledProducts.publish",
  viewCounterFlush: "sched:viewCounters.flush",
  analyticsDailyRollup: "sched:analyticsDailyRollup.run",
  analyticsReconciliation: "sched:analyticsReconciliation.run",
  snappaySweep: "sched:snappay.sweep",
} as const;

export type CommerceMaintenanceJobName =
  (typeof COMMERCE_MAINTENANCE_JOBS)[keyof typeof COMMERCE_MAINTENANCE_JOBS];

export type AnalyticsMaintenanceJobName =
  (typeof ANALYTICS_MAINTENANCE_JOBS)[keyof typeof ANALYTICS_MAINTENANCE_JOBS];

export type MaintenanceJobName = CommerceMaintenanceJobName | AnalyticsMaintenanceJobName;

export type SnappayPaymentJobName =
  (typeof SNAPPAY_PAYMENT_JOBS)[keyof typeof SNAPPAY_PAYMENT_JOBS];

export type MaintenanceJobData =
  | Record<string, never>
  | {
      operationId: number;
      retryCount: number;
    };
