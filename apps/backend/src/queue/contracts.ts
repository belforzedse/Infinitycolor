import type { AuditJobContext } from "../audit/types";

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
  cartCleanupReconcile: "cartCleanup.reconcile",
  anipoBarcodeReconcile: "anipoBarcodes.reconcile",
} as const;

export const ANALYTICS_MAINTENANCE_JOBS = {
  viewCounterFlush: "viewCounters.flush",
  analyticsDailyRollup: "analyticsDailyRollup.run",
  analyticsOutboxRepair: "analyticsOutboxRepair.run",
} as const;

export const SNAPPAY_PAYMENT_JOBS = {
  operation: "snappay.operation",
  sweep: "snappay.sweep",
} as const;

export const WALLET_TOPUP_PAYMENT_JOBS = {
  reconcile: "walletTopups.reconcile",
} as const;

export const MAINTENANCE_SCHEDULERS = {
  stockReservationExpiry: "sched:stockReservations.expire",
  reserveOrderExpiry: "sched:reserveOrders.expire",
  scheduledProductReconcile: "sched:scheduledProducts.reconcile",
  cartCleanupReconcile: "sched:cartCleanup.reconcile",
  viewCounterFlush: "sched:viewCounters.flush",
  analyticsDailyRollup: "sched:analyticsDailyRollup.run",
  analyticsOutboxRepair: "sched:analyticsOutboxRepair.run",
  snappaySweep: "sched:snappay.sweep",
  walletTopupReconcile: "sched:walletTopups.reconcile",
  anipoBarcodeReconcile: "sched:anipoBarcodes.reconcile",
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
  /** Minimal, sanitized causal context. The worker always supplies its own actor. */
  auditContext?: AuditJobContext;
};

export type MaintenanceJobData =
  | Record<string, never>
  | ScheduledProductPublicationJobData
  | {
      operationId: number;
      retryCount: number;
    };
