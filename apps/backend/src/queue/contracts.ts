export const QUEUE_NAMES = {
  commerceMaintenance: "commerce-maintenance",
  analyticsMaintenance: "analytics-maintenance",
  payments: "payments",
} as const;

export const COMMERCE_MAINTENANCE_JOBS = {
  stockReservationExpiry: "stockReservations.expire",
  reserveOrderExpiry: "reserveOrders.expire",
  scheduledProductPublishOne: "scheduledProducts.publishOne",
  scheduledProductReconcile: "scheduledProducts.reconcile",
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
  scheduledProductReconcile: "sched:scheduledProducts.reconcile",
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

export type ScheduledProductPublicationJobData = {
  productId: number;
  scheduleRevision: number;
  expectedPublishAt: string;
};

export type MaintenanceJobData =
  | Record<string, never>
  | ScheduledProductPublicationJobData
  | {
      operationId: number;
      retryCount: number;
    };
