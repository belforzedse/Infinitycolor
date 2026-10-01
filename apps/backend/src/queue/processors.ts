import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import type { Strapi } from "@strapi/strapi";
import { runExpireReserveOrdersTick } from "../jobs/expireReserveOrders";
import { runExpireStockReservationsTick } from "../jobs/expireStockReservations";
import {
  ANALYTICS_MAINTENANCE_JOBS,
  COMMERCE_MAINTENANCE_JOBS,
  MEDIA_JOBS,
  SNAPPAY_PAYMENT_JOBS,
  WALLET_TOPUP_PAYMENT_JOBS,
  type EdgeCachePurgeJobData,
  type MaintenanceJobData,
  type MaintenanceJobName,
} from "./contracts";
import { clearProductOriginCaches } from "../utils/productOriginCache";

/** How long a job waits when another worker holds the file's processing lease. */
const MEDIA_BUSY_DELAY_MS = 30_000;

type MediaJobDeps = {
  strapi: Strapi;
  uploadsDir: string;
  jobId: string | null;
  attempt: number;
};

/**
 * Shared error policy for media jobs:
 *  - another worker is processing the same file → wait and retry without spending an
 *    attempt (the lease makes the overlap harmless, this just avoids busy failures);
 *  - a failure re-running cannot fix (no ffmpeg, corrupt or oversized input) → fail
 *    permanently instead of burning the backoff schedule;
 *  - anything else → normal BullMQ retry.
 */
async function runMediaJob<T>(
  strapi: Strapi,
  job: Job<MaintenanceJobData, unknown, MaintenanceJobName | string>,
  token: string | undefined,
  run: (deps: MediaJobDeps) => Promise<T>,
): Promise<T> {
  const path = await import("node:path");
  const { MediaBusyError } = await import("../services/media/normalize-upload-video");
  const { MediaProcessingError } = await import("../services/media/media-process");
  const deps: MediaJobDeps = {
    strapi,
    uploadsDir: path.join(strapi.dirs.static.public, "uploads"),
    jobId: job.id ? String(job.id) : null,
    attempt: (job.attemptsMade ?? 0) + 1,
  };
  try {
    return await run(deps);
  } catch (error) {
    if (error instanceof MediaBusyError && token && typeof job.moveToDelayed === "function") {
      await job.moveToDelayed(Date.now() + MEDIA_BUSY_DELAY_MS, token);
      throw new DelayedError();
    }
    if (error instanceof MediaProcessingError && !error.retryable) {
      // Retrying will not conjure a binary or repair the upload. Fail the job permanently
      // and leave a clear line rather than burning the backoff schedule.
      strapi.log.error(`[media] ${error.code}: ${error.message}`);
      throw new UnrecoverableError(error.message);
    }
    throw error;
  }
}

export async function processMaintenanceJob(
  strapi: Strapi,
  job: Job<MaintenanceJobData, unknown, MaintenanceJobName | string>,
  token?: string,
): Promise<unknown> {
  switch (job.name) {
    case COMMERCE_MAINTENANCE_JOBS.stockReservationExpiry:
      return runExpireStockReservationsTick(strapi);
    case COMMERCE_MAINTENANCE_JOBS.reserveOrderExpiry:
      return runExpireReserveOrdersTick(strapi);
    case COMMERCE_MAINTENANCE_JOBS.scheduledProductPublishOne: {
      const { processScheduledProductPublicationJob } = await import(
        "../jobs/publishScheduledProducts"
      );
      return processScheduledProductPublicationJob(strapi, job as any, token);
    }
    case COMMERCE_MAINTENANCE_JOBS.scheduledProductReconcile: {
      const { runScheduledProductsReconciliation } = await import(
        "../jobs/publishScheduledProducts"
      );
      return runScheduledProductsReconciliation(strapi);
    }
    case COMMERCE_MAINTENANCE_JOBS.cartCleanupReconcile: {
      const { runReconcileCartCleanupTick } = await import("../jobs/reconcileCartCleanup");
      return runReconcileCartCleanupTick(strapi);
    }
    case COMMERCE_MAINTENANCE_JOBS.productTrashRetention: {
      const { runTrashRetentionSweep } = await import("../jobs/purgeExpiredTrashedProducts");
      return runTrashRetentionSweep(strapi);
    }
    case COMMERCE_MAINTENANCE_JOBS.anipoBarcodeReconcile: {
      const { runAnipoBarcodeReconciliation } = await import(
        "../api/order/services/anipoBarcodeWorkflow"
      );
      const barcode = await runAnipoBarcodeReconciliation(strapi);
      const { runAnipoRecipientSyncReconciliation } = await import(
        "../api/order/services/anipoRecipientSync"
      );
      const recipient = await runAnipoRecipientSyncReconciliation(strapi);
      return { barcode, recipient };
    }
    case COMMERCE_MAINTENANCE_JOBS.anipoRegisterOne: {
      const { orderId } = job.data as { orderId: number };
      const { processAnipoRegistrationJob } = await import(
        "../api/order/services/anipoBarcodeWorkflow"
      );
      return processAnipoRegistrationJob(strapi, orderId, (job.attemptsMade ?? 0) + 1, Number(job.opts.attempts || 1));
    }
    case COMMERCE_MAINTENANCE_JOBS.anipoRecipientSyncOne: {
      const { orderId, expectedRevision } = job.data as {
        orderId: number;
        expectedRevision: number;
      };
      const { processAnipoRecipientSync } = await import(
        "../api/order/services/anipoRecipientSync"
      );
      return processAnipoRecipientSync(strapi, orderId, expectedRevision);
    }
    case COMMERCE_MAINTENANCE_JOBS.staffOrderAlert: {
      const { orderId } = job.data as { orderId: number };
      const { notifyStaffOrderStartedSms } = await import(
        "../services/sms/staff-alerts"
      );
      return notifyStaffOrderStartedSms(strapi as any, { orderId });
    }
    case COMMERCE_MAINTENANCE_JOBS.edgeCachePurge: {
      const { kind, paths, reason, origin } = job.data as EdgeCachePurgeJobData;
      // Origin first, edge second. `invalidatePaths` warms the L2 by re-rendering
      // the storefront, so clearing Strapi's caches afterwards would just bake the
      // stale response back into nginx and Arvan.
      if (origin?.productSlug) {
        await clearProductOriginCaches(strapi, origin.productSlug, {
          availabilityCrossed: Boolean(origin.availabilityCrossed),
          logPrefix: `edge-cache:${kind}`,
        });
      }
      const { invalidatePaths } = await import("../utils/edgeCache");
      return invalidatePaths(paths, { logPrefix: `edge-cache:${kind}${reason ? `:${reason}` : ""}` });
    }
    case ANALYTICS_MAINTENANCE_JOBS.viewCounterFlush: {
      const viewService = strapi.service("api::product-view.product-view") as {
        flushQueuedCounters: () => Promise<void>;
      };
      await viewService.flushQueuedCounters();
      return { status: "completed" };
    }
    case ANALYTICS_MAINTENANCE_JOBS.analyticsDailyRollup: {
      const { runAnalyticsDailyRollupTick } = await import("../jobs/analyticsDailyRollup");
      return runAnalyticsDailyRollupTick(strapi);
    }
    case ANALYTICS_MAINTENANCE_JOBS.analyticsOutboxRepair: {
      const { runAnalyticsOutboxRepairTick } = await import("../jobs/analyticsOutboxRepair");
      return runAnalyticsOutboxRepairTick(strapi);
    }
    case MEDIA_JOBS.normalizeStoryVideo: {
      const { storyId, itemKey, fileId } = job.data as {
        storyId: number;
        itemKey: string;
        fileId: number;
      };
      const { normalizeStoryVideo } = await import("../services/media/normalize-story-video");
      return runMediaJob(strapi, job, token, (deps) =>
        normalizeStoryVideo(storyId, itemKey, fileId, deps),
      );
    }
    case MEDIA_JOBS.normalizeProductVideo: {
      const { productId, fileId } = job.data as { productId: number; fileId: number };
      const { normalizeProductVideoFile } = await import(
        "../services/media/normalize-product-video"
      );
      // The pipeline clears the product's origin caches itself whenever it repoints the
      // file, whichever job (upload, product, story) happened to do the work.
      return runMediaJob(strapi, job, token, (deps) =>
        normalizeProductVideoFile(productId, fileId, deps),
      );
    }
    case MEDIA_JOBS.normalizeUploadedFile: {
      const { fileId, force, webmEnabled, hlsEnabled } = job.data as { fileId: number; force?: boolean; webmEnabled?: boolean; hlsEnabled?: boolean };
      const { loadUploadVideoFile, normalizeUploadFile } = await import(
        "../services/media/normalize-upload-video"
      );
      return runMediaJob(strapi, job, token, async (deps) => {
        const file = await loadUploadVideoFile(strapi, fileId);
        if (!file) {
          return { fileId, status: "missing" as const, detail: "upload row not found" };
        }
        return normalizeUploadFile(file, { ...deps, force: force === true, webmEnabled, hlsEnabled });
      });
    }
    case SNAPPAY_PAYMENT_JOBS.operation: {
      const operationId = Number((job as any)?.data?.operationId);
      if (!Number.isInteger(operationId) || operationId <= 0) {
        throw new UnrecoverableError("Invalid SnappPay operation id");
      }
      const { processSnappayOperation } = await import(
        "../api/payment-gateway/services/snappay-orchestrator"
      );
      return processSnappayOperation(strapi, operationId);
    }
    case SNAPPAY_PAYMENT_JOBS.sweep: {
      const { sweepSnappayOperations } = await import(
        "../api/payment-gateway/services/snappay-orchestrator"
      );
      return sweepSnappayOperations(strapi);
    }
    case WALLET_TOPUP_PAYMENT_JOBS.reconcile: {
      const { reconcileWalletTopups } = await import(
        "../api/wallet-topup/services/wallet-topup"
      );
      return reconcileWalletTopups(strapi);
    }
    default:
      throw new UnrecoverableError(`Unknown maintenance job: ${job.name}`);
  }
}
