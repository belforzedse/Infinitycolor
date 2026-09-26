jest.mock(
  "bullmq",
  () => ({
    UnrecoverableError: class UnrecoverableError extends Error {
      name = "UnrecoverableError";
    },
    DelayedError: class DelayedError extends Error {
      name = "DelayedError";
    },
  }),
  { virtual: true },
);

jest.mock("../../jobs/expireStockReservations", () => ({
  runExpireStockReservationsTick: jest.fn(),
}));
jest.mock("../../jobs/expireReserveOrders", () => ({
  runExpireReserveOrdersTick: jest.fn(),
}));
jest.mock("../../jobs/publishScheduledProducts", () => ({
  processScheduledProductPublicationJob: jest.fn(),
  runScheduledProductsReconciliation: jest.fn(),
}));
jest.mock("../../api/payment-gateway/services/snappay-orchestrator", () => ({
  processSnappayOperation: jest.fn(),
  sweepSnappayOperations: jest.fn(),
}));
jest.mock("../../jobs/analyticsDailyRollup", () => ({
  runAnalyticsDailyRollupTick: jest.fn(),
}));
jest.mock("../../jobs/analyticsOutboxRepair", () => ({
  runAnalyticsOutboxRepairTick: jest.fn(),
}));
jest.mock("../../api/order/services/anipoBarcodeWorkflow", () => ({
  runAnipoBarcodeReconciliation: jest.fn(),
  processAnipoRegistrationJob: jest.fn(),
}));
jest.mock("../../api/order/services/anipoRecipientSync", () => ({
  processAnipoRecipientSync: jest.fn(),
  runAnipoRecipientSyncReconciliation: jest.fn(),
}));
jest.mock("../../services/sms/staff-alerts", () => ({
  notifyStaffOrderStartedSms: jest.fn(),
}));
jest.mock("../../services/media/normalize-product-video", () => ({
  normalizeProductVideoFile: jest.fn(),
}));
jest.mock("../../utils/productOriginCache", () => ({
  clearProductOriginCaches: jest.fn(),
}));

import { runExpireReserveOrdersTick } from "../../jobs/expireReserveOrders";
import { runExpireStockReservationsTick } from "../../jobs/expireStockReservations";
import {
  processScheduledProductPublicationJob,
  runScheduledProductsReconciliation,
} from "../../jobs/publishScheduledProducts";
import {
  ANALYTICS_MAINTENANCE_JOBS,
  COMMERCE_MAINTENANCE_JOBS,
  MEDIA_JOBS,
  SNAPPAY_PAYMENT_JOBS,
} from "../contracts";
import { processMaintenanceJob } from "../processors";
import { normalizeProductVideoFile } from "../../services/media/normalize-product-video";
import { clearProductOriginCaches } from "../../utils/productOriginCache";
import { FfmpegUnavailableError } from "../../services/media/video-normalization";
import {
  processSnappayOperation,
  sweepSnappayOperations,
} from "../../api/payment-gateway/services/snappay-orchestrator";
import { runAnalyticsDailyRollupTick } from "../../jobs/analyticsDailyRollup";
import { runAnalyticsOutboxRepairTick } from "../../jobs/analyticsOutboxRepair";
import { processAnipoRegistrationJob, runAnipoBarcodeReconciliation } from "../../api/order/services/anipoBarcodeWorkflow";
import {
  processAnipoRecipientSync,
  runAnipoRecipientSyncReconciliation,
} from "../../api/order/services/anipoRecipientSync";

const mockedRunExpireStockReservationsTick = runExpireStockReservationsTick as jest.MockedFunction<
  typeof runExpireStockReservationsTick
>;
const mockedRunExpireReserveOrdersTick = runExpireReserveOrdersTick as jest.MockedFunction<
  typeof runExpireReserveOrdersTick
>;
const mockedProcessScheduledProductPublicationJob =
  processScheduledProductPublicationJob as jest.MockedFunction<
    typeof processScheduledProductPublicationJob
  >;
const mockedRunScheduledProductsReconciliation =
  runScheduledProductsReconciliation as jest.MockedFunction<
    typeof runScheduledProductsReconciliation
  >;
const mockedProcessSnappayOperation = processSnappayOperation as jest.MockedFunction<
  typeof processSnappayOperation
>;
const mockedSweepSnappayOperations = sweepSnappayOperations as jest.MockedFunction<
  typeof sweepSnappayOperations
>;
const mockedRunAnalyticsDailyRollupTick = runAnalyticsDailyRollupTick as jest.MockedFunction<
  typeof runAnalyticsDailyRollupTick
>;
const mockedRunAnalyticsOutboxRepairTick = runAnalyticsOutboxRepairTick as jest.MockedFunction<
  typeof runAnalyticsOutboxRepairTick
>;
const mockedRunAnipoBarcodeReconciliation =
  runAnipoBarcodeReconciliation as jest.MockedFunction<
    typeof runAnipoBarcodeReconciliation
  >;
const mockedProcessAnipoRecipientSync = processAnipoRecipientSync as jest.MockedFunction<
  typeof processAnipoRecipientSync
>;
const mockedRunAnipoRecipientSyncReconciliation =
  runAnipoRecipientSyncReconciliation as jest.MockedFunction<
    typeof runAnipoRecipientSyncReconciliation
  >;
const mockedNormalizeProductVideoFile = normalizeProductVideoFile as jest.MockedFunction<
  typeof normalizeProductVideoFile
>;
const mockedClearProductOriginCaches = clearProductOriginCaches as jest.MockedFunction<
  typeof clearProductOriginCaches
>;

function createMockStrapi() {
  const viewService = {
    flushQueuedCounters: jest.fn().mockResolvedValue(undefined),
  };

  return {
    log: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    service: jest.fn(() => viewService),
    dirs: { static: { public: "/app/public" } },
  } as any;
}

describe("queue processors", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("dispatches stock reservation expiry jobs to the existing job runner", async () => {
    const strapi = createMockStrapi();
    mockedRunExpireStockReservationsTick.mockResolvedValue({
      status: "completed",
      stats: {},
    } as any);

    await processMaintenanceJob(strapi, {
      name: COMMERCE_MAINTENANCE_JOBS.stockReservationExpiry,
    } as any);

    expect(mockedRunExpireStockReservationsTick).toHaveBeenCalledWith(strapi);
  });

  it("dispatches reserve-order expiry jobs to the existing job runner", async () => {
    const strapi = createMockStrapi();
    mockedRunExpireReserveOrdersTick.mockResolvedValue({ status: "completed", stats: {} } as any);

    await processMaintenanceJob(strapi, {
      name: COMMERCE_MAINTENANCE_JOBS.reserveOrderExpiry,
    } as any);

    expect(mockedRunExpireReserveOrdersTick).toHaveBeenCalledWith(strapi);
  });

  it("dispatches one-product scheduled publication jobs", async () => {
    const strapi = createMockStrapi();
    mockedProcessScheduledProductPublicationJob.mockResolvedValue({ outcome: "published" });
    const job = {
      name: COMMERCE_MAINTENANCE_JOBS.scheduledProductPublishOne,
      data: {
        productId: 10,
        scheduleRevision: 3,
        expectedPublishAt: "2026-08-08T12:00:00.000Z",
      },
    } as any;

    await processMaintenanceJob(strapi, job, "worker-token");

    expect(mockedProcessScheduledProductPublicationJob).toHaveBeenCalledWith(
      strapi,
      job,
      "worker-token",
    );
  });

  it("dispatches scheduled publication reconciliation jobs", async () => {
    const strapi = createMockStrapi();
    mockedRunScheduledProductsReconciliation.mockResolvedValue({
      scanned: 0,
      queued: 0,
      present: 0,
      skipped: 0,
      effects: 0,
      effectFailures: 0,
    });

    await processMaintenanceJob(strapi, {
      name: COMMERCE_MAINTENANCE_JOBS.scheduledProductReconcile,
      data: {},
    } as any);

    expect(mockedRunScheduledProductsReconciliation).toHaveBeenCalledWith(strapi);
  });

  it("dispatches Anipo barcode reconciliation jobs", async () => {
    const strapi = createMockStrapi();
    mockedRunAnipoBarcodeReconciliation.mockResolvedValue({ status: "completed" } as any);
    mockedRunAnipoRecipientSyncReconciliation.mockResolvedValue({ scanned: 0, queued: 0 });

    await processMaintenanceJob(strapi, {
      name: COMMERCE_MAINTENANCE_JOBS.anipoBarcodeReconcile,
      data: {},
    } as any);

    expect(mockedRunAnipoBarcodeReconciliation).toHaveBeenCalledWith(strapi);
    expect(mockedRunAnipoRecipientSyncReconciliation).toHaveBeenCalledWith(strapi);
  });

  it("dispatches a single Anipo registration with the worker retry budget", async () => {
    const strapi = createMockStrapi();
    (processAnipoRegistrationJob as jest.Mock).mockResolvedValue({ state: "Pending" });
    await processMaintenanceJob(strapi, {
      name: COMMERCE_MAINTENANCE_JOBS.anipoRegisterOne,
      data: { orderId: 42 },
      attemptsMade: 1,
      opts: { attempts: 5 },
    } as any);
    expect(processAnipoRegistrationJob).toHaveBeenCalledWith(strapi, 42, 2, 5);
  });

  it("dispatches one Anipo recipient synchronization", async () => {
    const strapi = createMockStrapi();
    mockedProcessAnipoRecipientSync.mockResolvedValue({ status: "synced" });
    await processMaintenanceJob(strapi, {
      name: COMMERCE_MAINTENANCE_JOBS.anipoRecipientSyncOne,
      data: { orderId: 42, expectedRevision: 3 },
    } as any);
    expect(mockedProcessAnipoRecipientSync).toHaveBeenCalledWith(strapi, 42, 3);
  });

  it("dispatches the staff order alert to the SMS sender", async () => {
    const strapi = createMockStrapi();
    const { notifyStaffOrderStartedSms } = await import("../../services/sms/staff-alerts");
    (notifyStaffOrderStartedSms as jest.Mock).mockResolvedValue({ ok: true, sent: 2 });

    await processMaintenanceJob(strapi, {
      name: COMMERCE_MAINTENANCE_JOBS.staffOrderAlert,
      data: { orderId: 501 },
    } as any);

    expect(notifyStaffOrderStartedSms).toHaveBeenCalledWith(strapi, { orderId: 501 });
  });

  it("dispatches view-counter flush jobs to the product-view service", async () => {
    const strapi = createMockStrapi();
    const viewService = strapi.service("api::product-view.product-view");

    await processMaintenanceJob(strapi, {
      name: ANALYTICS_MAINTENANCE_JOBS.viewCounterFlush,
    } as any);

    expect(strapi.service).toHaveBeenCalledWith("api::product-view.product-view");
    expect(viewService.flushQueuedCounters).toHaveBeenCalledTimes(1);
  });

  it("dispatches the analytics daily rollup job", async () => {
    const strapi = createMockStrapi();
    mockedRunAnalyticsDailyRollupTick.mockResolvedValue({ status: "completed", stats: {} } as any);

    await processMaintenanceJob(strapi, {
      name: ANALYTICS_MAINTENANCE_JOBS.analyticsDailyRollup,
    } as any);

    expect(mockedRunAnalyticsDailyRollupTick).toHaveBeenCalledWith(strapi);
  });

  it("dispatches the analytics outbox repair job", async () => {
    const strapi = createMockStrapi();
    mockedRunAnalyticsOutboxRepairTick.mockResolvedValue({ status: "completed", stats: {} } as any);

    await processMaintenanceJob(strapi, {
      name: ANALYTICS_MAINTENANCE_JOBS.analyticsOutboxRepair,
    } as any);

    expect(mockedRunAnalyticsOutboxRepairTick).toHaveBeenCalledWith(strapi);
  });

  it("dispatches durable SnappPay operations by database id", async () => {
    const strapi = createMockStrapi();
    mockedProcessSnappayOperation.mockResolvedValue({ status: "completed" });

    await processMaintenanceJob(strapi, {
      name: SNAPPAY_PAYMENT_JOBS.operation,
      data: { operationId: 42, retryCount: 0 },
    } as any);

    expect(mockedProcessSnappayOperation).toHaveBeenCalledWith(strapi, 42);
  });

  it("dispatches the SnappPay recovery sweep", async () => {
    const strapi = createMockStrapi();
    mockedSweepSnappayOperations.mockResolvedValue({
      queued: 0,
      health: {
        verifiedUnsettledOver15m: 0,
        manualReview: 0,
      },
    });

    await processMaintenanceJob(strapi, {
      name: SNAPPAY_PAYMENT_JOBS.sweep,
      data: {},
    } as any);

    expect(mockedSweepSnappayOperations).toHaveBeenCalledWith(strapi);
  });

  it("rejects malformed SnappPay operation ids without provider work", async () => {
    await expect(
      processMaintenanceJob(createMockStrapi(), {
        name: SNAPPAY_PAYMENT_JOBS.operation,
        data: { operationId: "not-an-id" },
      } as any),
    ).rejects.toThrow("Invalid SnappPay operation id");
    expect(mockedProcessSnappayOperation).not.toHaveBeenCalled();
  });

  it("normalizes a product gallery clip with job context; cache clearing belongs to the pipeline", async () => {
    const strapi = createMockStrapi();
    mockedNormalizeProductVideoFile.mockResolvedValue({
      productId: 4624,
      slug: "fantasy-sleeping-set-n002",
      status: "normalized",
      files: [{ fileId: 120001, status: "normalized" }],
    } as any);

    await processMaintenanceJob(strapi, {
      id: "normalize-product-video-120001",
      name: MEDIA_JOBS.normalizeProductVideo,
      data: { productId: 4624, fileId: 120001 },
      attemptsMade: 1,
    } as any);

    expect(mockedNormalizeProductVideoFile).toHaveBeenCalledWith(4624, 120001, {
      strapi,
      uploadsDir: "/app/public/uploads",
      jobId: "normalize-product-video-120001",
      attempt: 2,
    });
    // The pipeline clears the product's caches on every row switch, whichever job ran it.
    expect(mockedClearProductOriginCaches).not.toHaveBeenCalled();
  });

  it("delays, without spending an attempt, when another worker holds the file", async () => {
    const strapi = createMockStrapi();
    const { MediaBusyError } = jest.requireActual("../../services/media/normalize-upload-video");
    mockedNormalizeProductVideoFile.mockRejectedValue(new MediaBusyError(9));
    const moveToDelayed = jest.fn(async () => undefined);

    await expect(
      processMaintenanceJob(
        strapi,
        { id: "j", name: MEDIA_JOBS.normalizeProductVideo, data: { productId: 1, fileId: 9 }, moveToDelayed } as any,
        "lock-token",
      ),
    ).rejects.toMatchObject({ name: "DelayedError" });
    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "lock-token");
  });

  it("fails permanently on an upload re-running cannot fix", async () => {
    const strapi = createMockStrapi();
    const { MediaProcessingError } = jest.requireActual("../../services/media/media-process");
    mockedNormalizeProductVideoFile.mockRejectedValue(
      new MediaProcessingError("no_video_stream", "the file has no video stream"),
    );
    await expect(
      processMaintenanceJob(strapi, {
        name: MEDIA_JOBS.normalizeProductVideo,
        data: { productId: 1, fileId: 9 },
      } as any),
    ).rejects.toMatchObject({ name: "UnrecoverableError" });
  });

  it("fails permanently when ffmpeg is missing rather than retrying the transcode", async () => {
    const strapi = createMockStrapi();
    mockedNormalizeProductVideoFile.mockRejectedValue(new FfmpegUnavailableError("ffmpeg"));

    await expect(
      processMaintenanceJob(strapi, {
        name: MEDIA_JOBS.normalizeProductVideo,
        data: { productId: 1, fileId: 9 },
      } as any),
    ).rejects.toThrow("ffmpeg is not available");
    expect(strapi.log.error).toHaveBeenCalled();
    expect(mockedClearProductOriginCaches).not.toHaveBeenCalled();
  });

  it("fails unknown job names without retrying forever", async () => {
    await expect(
      processMaintenanceJob(createMockStrapi(), { name: "unknown.job" } as any),
    ).rejects.toThrow("Unknown maintenance job: unknown.job");
  });
});
