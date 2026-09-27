jest.mock("../../api/product/services/product-publication", () => ({
  publishScheduledProduct: jest.fn(),
  recordScheduledPublicationTransientFailure: jest.fn(),
  runPublicationEffects: jest.fn(),
}));

jest.mock("../../queue/product-publication-queue", () => ({
  enqueueScheduledProductPublication: jest.fn(),
  scheduledProductJobExists: jest.fn(),
}));

import { DelayedError, UnrecoverableError } from "bullmq";
import {
  publishScheduledProduct,
  recordScheduledPublicationTransientFailure,
  runPublicationEffects,
} from "../../api/product/services/product-publication";
import {
  enqueueScheduledProductPublication,
  scheduledProductJobExists,
} from "../../queue/product-publication-queue";
import {
  processScheduledProductPublicationJob,
  runScheduledProductsReconciliation,
} from "../publishScheduledProducts";

const mockedPublish = publishScheduledProduct as jest.MockedFunction<typeof publishScheduledProduct>;
const mockedTransientFailure = recordScheduledPublicationTransientFailure as jest.MockedFunction<
  typeof recordScheduledPublicationTransientFailure
>;
const mockedEffects = runPublicationEffects as jest.MockedFunction<typeof runPublicationEffects>;
const mockedEnqueue = enqueueScheduledProductPublication as jest.MockedFunction<
  typeof enqueueScheduledProductPublication
>;
const mockedJobExists = scheduledProductJobExists as jest.MockedFunction<
  typeof scheduledProductJobExists
>;

const jobData = {
  productId: 10,
  scheduleRevision: 3,
  expectedPublishAt: "2026-08-08T12:00:00.000Z",
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    productId: 10,
    status: "Scheduled" as const,
    scheduledPublishAt: jobData.expectedPublishAt,
    scheduledPublishTimezone: "Asia/Tehran",
    scheduleRevision: 3,
    publicationRevision: 0,
    changed: false,
    needsPublicationEffects: false,
    ...overrides,
  };
}

function makeStrapi(connection?: jest.Mock) {
  return {
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    db: { connection: connection || jest.fn() },
  } as any;
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-publish-10-3",
    data: jobData,
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function resolvedQuery<T>(value: T) {
  const query: any = {};
  for (const method of [
    "select",
    "where",
    "whereNull",
    "whereNotNull",
    "andWhere",
    "whereRaw",
    "orderBy",
    "limit",
  ]) {
    query[method] = jest.fn(() => query);
  }
  query.then = (resolve: (value: T) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve(value).then(resolve, reject);
  return query;
}

describe("scheduled product publication jobs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("publishes one due revision and completes its effects", async () => {
    mockedPublish.mockResolvedValue({
      outcome: "published",
      result: result({ status: "Active", publicationRevision: 4, changed: true }),
    });
    mockedEffects.mockResolvedValue({ completed: true, revision: 4 });

    await expect(processScheduledProductPublicationJob(makeStrapi(), makeJob())).resolves.toEqual({
      outcome: "published",
    });
    expect(mockedPublish).toHaveBeenCalledWith(expect.anything(), {
      ...jobData,
      jobId: "product-publish-10-3",
    });
    expect(mockedEffects).toHaveBeenCalledWith(expect.anything(), 10, 4);
  });

  it("treats stale and cancelled revisions as successful no-ops", async () => {
    mockedPublish.mockResolvedValue({ outcome: "stale", result: result() });

    await expect(processScheduledProductPublicationJob(makeStrapi(), makeJob())).resolves.toEqual({
      outcome: "stale",
    });
    expect(mockedEffects).not.toHaveBeenCalled();
  });

  it("moves an early delivery back to the absolute due time", async () => {
    const dueAt = "2026-08-08T13:00:00.000Z";
    const job = makeJob();
    mockedPublish.mockResolvedValue({ outcome: "early", dueAt, result: result() });

    await expect(
      processScheduledProductPublicationJob(makeStrapi(), job, "worker-token"),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(Date.parse(dueAt), "worker-token");
  });

  it("marks permanent validation failures as unrecoverable", async () => {
    mockedPublish.mockResolvedValue({
      outcome: "permanent-failure",
      code: "PRODUCT_COVER_MEDIA_REQUIRED",
      result: result({ changed: true }),
    });

    await expect(
      processScheduledProductPublicationJob(makeStrapi(), makeJob()),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mockedEffects).not.toHaveBeenCalled();
  });

  it("persists transient delivery failures before BullMQ retries", async () => {
    const error = new Error("database connection lost");
    mockedPublish.mockRejectedValue(error);
    mockedTransientFailure.mockResolvedValue(true);
    const job = makeJob({ attemptsMade: 2 });

    await expect(
      processScheduledProductPublicationJob(makeStrapi(), job),
    ).rejects.toBe(error);
    expect(mockedTransientFailure).toHaveBeenCalledWith(expect.anything(), {
      ...jobData,
      error,
      retryDelayMs: 120_000,
    });
  });

  it("rejects malformed jobs before touching product state", async () => {
    await expect(
      processScheduledProductPublicationJob(
        makeStrapi(),
        makeJob({ data: { ...jobData, scheduleRevision: 0 } }),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mockedPublish).not.toHaveBeenCalled();
  });
});

describe("scheduled product reconciliation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("repairs missing jobs and drains pending publication effects", async () => {
    const schedules = [{
      id: 10,
      scheduled_publish_at: jobData.expectedPublishAt,
      scheduled_publish_revision: 3,
      scheduled_publish_failure_kind: null,
      scheduled_publish_next_retry_at: null,
    }];
    const effects = [{ id: 11, publication_revision: 7 }];
    const scheduleQuery = resolvedQuery(schedules);
    const effectsQuery = resolvedQuery(effects);
    const connection = jest.fn()
      .mockReturnValueOnce(scheduleQuery)
      .mockReturnValueOnce(effectsQuery);
    mockedJobExists.mockResolvedValue(false);
    mockedEnqueue.mockResolvedValue({} as any);
    mockedEffects.mockResolvedValue({ completed: true, revision: 7 });

    await expect(
      runScheduledProductsReconciliation(makeStrapi(connection), {
        now: new Date("2026-08-08T12:00:00.000Z"),
      }),
    ).resolves.toEqual({
      scanned: 1,
      queued: 1,
      present: 0,
      skipped: 0,
      effects: 1,
      effectFailures: 0,
    });
    expect(mockedEnqueue).toHaveBeenCalledWith(jobData);
    expect(mockedEffects).toHaveBeenCalledWith(expect.anything(), 11, 7);
    // A trashed product never gets its schedule re-queued, but a trashed
    // product's pending cache effects (its move out of the storefront) still run.
    expect(scheduleQuery.whereNull).toHaveBeenCalledWith("removed_at");
    expect(effectsQuery.whereNull).not.toHaveBeenCalled();
  });

  it("does not automatically retry a permanent schedule failure", async () => {
    const schedules = [{
      id: 10,
      scheduled_publish_at: jobData.expectedPublishAt,
      scheduled_publish_revision: 3,
      scheduled_publish_failure_kind: "Permanent",
      scheduled_publish_next_retry_at: null,
    }];
    const connection = jest.fn()
      .mockReturnValueOnce(resolvedQuery(schedules))
      .mockReturnValueOnce(resolvedQuery([]));

    const summary = await runScheduledProductsReconciliation(makeStrapi(connection));

    expect(summary.skipped).toBe(1);
    expect(mockedJobExists).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("contains a queue outage so the next minute can reconcile again", async () => {
    const schedules = [{
      id: 10,
      scheduled_publish_at: jobData.expectedPublishAt,
      scheduled_publish_revision: 3,
      scheduled_publish_failure_kind: null,
      scheduled_publish_next_retry_at: null,
    }];
    const connection = jest.fn()
      .mockReturnValueOnce(resolvedQuery(schedules))
      .mockReturnValueOnce(resolvedQuery([]));
    mockedJobExists.mockResolvedValue(false);
    mockedEnqueue.mockRejectedValue(new Error("redis unavailable"));

    const summary = await runScheduledProductsReconciliation(makeStrapi(connection));

    expect(summary).toEqual(expect.objectContaining({ scanned: 1, queued: 0, skipped: 1 }));
  });
});
