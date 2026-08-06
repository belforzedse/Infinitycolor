import { UnrecoverableError, type Job } from "bullmq";
import type { Strapi } from "@strapi/strapi";
import { runExpireReserveOrdersTick } from "../jobs/expireReserveOrders";
import { runExpireStockReservationsTick } from "../jobs/expireStockReservations";
import {
  ANALYTICS_MAINTENANCE_JOBS,
  COMMERCE_MAINTENANCE_JOBS,
  SNAPPAY_PAYMENT_JOBS,
  type MaintenanceJobData,
  type MaintenanceJobName,
} from "./contracts";

export async function processMaintenanceJob(
  strapi: Strapi,
  job: Pick<Job<MaintenanceJobData, unknown, MaintenanceJobName | string>, "name">
): Promise<unknown> {
  switch (job.name) {
    case COMMERCE_MAINTENANCE_JOBS.stockReservationExpiry:
      return runExpireStockReservationsTick(strapi);
    case COMMERCE_MAINTENANCE_JOBS.reserveOrderExpiry:
      return runExpireReserveOrdersTick(strapi);
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
    case ANALYTICS_MAINTENANCE_JOBS.analyticsReconciliation: {
      const { runAnalyticsReconciliationTick } = await import("../jobs/analyticsReconciliation");
      return runAnalyticsReconciliationTick(strapi);
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
    default:
      throw new UnrecoverableError(`Unknown maintenance job: ${job.name}`);
  }
}
