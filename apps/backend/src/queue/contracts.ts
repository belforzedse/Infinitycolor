import type { AuditJobContext } from "../audit/types";

export const QUEUE_NAMES = {
  commerceMaintenance: "commerce-maintenance",
  analyticsMaintenance: "analytics-maintenance",
  payments: "payments",
  media: "media",
} as const;

export const COMMERCE_MAINTENANCE_JOBS = {
  stockReservationExpiry: "stockReservations.expire",
  reserveOrderExpiry: "reserveOrders.expire",
  scheduledProductPublishOne: "scheduledProducts.publishOne",
  scheduledProductReconcile: "scheduledProducts.reconcile",
  cartCleanupReconcile: "cartCleanup.reconcile",
  anipoBarcodeReconcile: "anipoBarcodes.reconcile",
  anipoRecipientSyncOne: "anipoRecipients.syncOne",
  edgeCachePurge: "edgeCache.purge",
  staffOrderAlert: "staffAlerts.orderStarted",
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

export const MEDIA_JOBS = {
  /** Transcode a story's video to web-safe progressive MP4 (see services/media). */
  normalizeStoryVideo: "media.normalizeStoryVideo",
  /** Transcode one product gallery/cover video to web-safe progressive MP4. */
  normalizeProductVideo: "media.normalizeProductVideo",
  /**
   * Transcode a raw `plugin::upload.file` row as soon as it lands, independent of any
   * product/story attachment. The product/story jobs only fire once the entity that owns
   * the file is saved — an admin picking a phone-recorded clip in the add-product form
   * (no product row yet) would otherwise never get a playable preview until after save.
   */
  normalizeUploadedFile: "media.normalizeUploadedFile",
} as const;

export type MediaJobName = (typeof MEDIA_JOBS)[keyof typeof MEDIA_JOBS];

export type NormalizeStoryVideoJobData = {
  storyId: number;
  itemKey: string;
  fileId: number;
};

export type NormalizeProductVideoJobData = {
  productId: number;
  fileId: number;
};

export type NormalizeUploadedFileJobData = {
  fileId: number;
};

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

export type AnipoRecipientSyncJobData = {
  orderId: number;
  expectedRevision: number;
};

/**
 * Refresh the gateway page cache and purge the edge for a set of storefront
 * paths. Carried on the queue rather than done inline so that a slow or
 * unreachable CDN can never delay a publish, a price change or a checkout.
 */
export type EdgeCachePurgeJobData = {
  /** What happened, for the log and for collapsing duplicates. */
  kind: string;
  paths: string[];
  reason?: string;
  /**
   * Origin caches to clear before the edge is refreshed. Without this the L2
   * refresh re-renders from a still-stale Strapi response and warms the edge
   * straight back up with it.
   */
  origin?: {
    /** Product slug whose Next cache tags should be revalidated. */
    productSlug?: string;
    /**
     * True when availability crossed in or out of stock, so product *cards*
     * changed too and every listing has to be invalidated. False when only the
     * low-stock number moved, which shows on the PDP alone.
     */
    availabilityCrossed?: boolean;
  };
};

/**
 * Tell the staff recipient list that an order reached «در حال انجام». Carried on
 * the queue because the enqueue happens inside the payment settlement
 * transaction: the fan-out must not hold that transaction open, and the worker
 * re-reads the order after commit so a rollback cannot produce a false alert.
 */
export type StaffOrderAlertJobData = {
  orderId: number;
};

export type MaintenanceJobData =
  | Record<string, never>
  | NormalizeStoryVideoJobData
  | NormalizeProductVideoJobData
  | NormalizeUploadedFileJobData
  | ScheduledProductPublicationJobData
  | AnipoRecipientSyncJobData
  | EdgeCachePurgeJobData
  | StaffOrderAlertJobData
  | {
      operationId: number;
      retryCount: number;
    };
