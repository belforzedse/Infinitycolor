import { UnrecoverableError, type Job } from "bullmq";
import type { Strapi } from "@strapi/strapi";
import { runExpireReserveOrdersTick } from "../jobs/expireReserveOrders";
import { runExpireStockReservationsTick } from "../jobs/expireStockReservations";
import {
  ANALYTICS_MAINTENANCE_JOBS,
  COMMERCE_MAINTENANCE_JOBS,
  MEDIA_JOBS,
  SNAPPAY_PAYMENT_JOBS,
  WALLET_TOPUP_PAYMENT_JOBS,
  type MaintenanceJobData,
  type MaintenanceJobName,
} from "./contracts";

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
    case COMMERCE_MAINTENANCE_JOBS.edgeCachePurge: {
      const { kind, paths, reason } = job.data as {
        kind: string;
        paths: string[];
        reason?: string;
      };
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
      const { storyId } = job.data as { storyId: number };
      const { normalizeStoryVideo } = await import("../services/media/normalize-story-video");
      const { FfmpegUnavailableError } = await import("../services/media/video-normalization");
      const path = await import("node:path");
      try {
        return await normalizeStoryVideo(storyId, {
          strapi,
          uploadsDir: path.join(strapi.dirs.static.public, "uploads"),
        });
      } catch (error) {
        if (error instanceof FfmpegUnavailableError) {
          // Retrying will not conjure a binary. Fail the job permanently and leave a
          // clear line rather than burning the backoff schedule.
          strapi.log.error(`[media] ${error.message}`);
          throw new UnrecoverableError(error.message);
        }
        throw error;
      }
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
