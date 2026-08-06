/**
 * Orchestration tests for the analytics reconciliation job: watermark-window
 * computation, tick capping, the per-day loop, and failure bookkeeping. The
 * comparison logic itself is covered separately in
 * src/api/report/analytics/reconcile/__tests__/commerceReconciliation.spec.ts —
 * this file mocks that module to isolate the job's own control flow.
 */

const resolveJoinsMock = jest.fn().mockResolvedValue({});
const reconcileCommerceWindowMock = jest.fn();
const upsertReconciliationRowMock = jest.fn().mockResolvedValue(undefined);
const getRefreshStateMock = jest.fn();
const markRunStartedMock = jest.fn().mockResolvedValue(undefined);
const markRunSucceededMock = jest.fn().mockResolvedValue(undefined);
const markRunFailedMock = jest.fn().mockResolvedValue(undefined);

jest.mock("../../api/report/services/product-analytics", () => ({
  resolveJoins: (...args: any[]) => resolveJoinsMock(...args),
}));

jest.mock("../../api/report/analytics/reconcile/commerceReconciliation", () => ({
  reconcileCommerceWindow: (...args: any[]) => reconcileCommerceWindowMock(...args),
  upsertReconciliationRow: (...args: any[]) => upsertReconciliationRowMock(...args),
}));

jest.mock("../../api/report/analytics/sources/refreshState", () => ({
  getRefreshState: (...args: any[]) => getRefreshStateMock(...args),
  markRunStarted: (...args: any[]) => markRunStartedMock(...args),
  markRunSucceeded: (...args: any[]) => markRunSucceededMock(...args),
  markRunFailed: (...args: any[]) => markRunFailedMock(...args),
}));

import { __resetBackgroundJobGuardsForTests } from "../backgroundJobRunner";
import { runAnalyticsReconciliationTick } from "../analyticsReconciliation";

function createMockStrapi() {
  return {
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    db: { connection: {} },
  } as any;
}

function matchedResult() {
  return {
    window: { start: "x", end: "x" },
    strapi: { orders: 1, grossToman: 100, netToman: 100 },
    matomo: { orders: 1, revenue: 100 },
    ordersDelta: 0,
    revenueRatio: 1,
    possibleCurrencyMismatch: false,
    status: "matched" as const,
  };
}

describe("runAnalyticsReconciliationTick", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveJoinsMock.mockResolvedValue({});
    reconcileCommerceWindowMock.mockResolvedValue(matchedResult());
    __resetBackgroundJobGuardsForTests();
  });

  it("first run (no watermark): seeds the configured initial lookback window ending yesterday", async () => {
    getRefreshStateMock.mockResolvedValue(null);
    const strapi = createMockStrapi();

    const result = await runAnalyticsReconciliationTick(strapi, {
      now: new Date("2026-05-15T10:00:00Z"), // Tehran-local: 2026-05-15 13:30
      initialLookbackDays: 3,
      maxDaysPerTick: 7,
    });

    expect(result.status).toBe("completed");
    expect((result as any).stats.startDay).toBe("2026-05-12");
    expect((result as any).stats.endDay).toBe("2026-05-14"); // yesterday, Tehran-local
    expect((result as any).stats.processedDays).toBe(3);
    expect(reconcileCommerceWindowMock).toHaveBeenCalledTimes(3);
    expect(upsertReconciliationRowMock).toHaveBeenCalledTimes(3);
    expect(markRunSucceededMock).toHaveBeenCalledWith(
      expect.anything(),
      "analytics_reconciliation",
      new Date("2026-05-14T00:00:00Z"),
    );
  });

  it("calls reconcileCommerceWindow with a [dayStart, dayEnd] pair for each day and upserts under that day's key", async () => {
    getRefreshStateMock.mockResolvedValue(null);
    const strapi = createMockStrapi();

    await runAnalyticsReconciliationTick(strapi, {
      now: new Date("2026-05-15T10:00:00Z"),
      initialLookbackDays: 2,
      maxDaysPerTick: 7,
    });

    expect(reconcileCommerceWindowMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      new Date("2026-05-13T00:00:00Z"),
      new Date("2026-05-13T23:59:59Z"),
    );
    expect(upsertReconciliationRowMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "2026-05-13",
      expect.objectContaining({ status: "matched" }),
    );
  });

  it("caps a large backfill at maxDaysPerTick so a single tick stays bounded", async () => {
    getRefreshStateMock.mockResolvedValue({
      sourceType: "analytics_reconciliation",
      watermark: new Date("2026-01-01T00:00:00Z"),
      lastRunAt: null,
      lastStatus: "success",
      lastError: null,
    });
    const strapi = createMockStrapi();

    const result = await runAnalyticsReconciliationTick(strapi, {
      now: new Date("2026-06-01T10:00:00Z"),
      initialLookbackDays: 30,
      maxDaysPerTick: 5,
    });

    expect((result as any).stats.startDay).toBe("2026-01-02");
    expect((result as any).stats.endDay).toBe("2026-01-06");
    expect((result as any).stats.processedDays).toBe(5);
  });

  it("is a no-op when the watermark is already at yesterday", async () => {
    getRefreshStateMock.mockResolvedValue({
      sourceType: "analytics_reconciliation",
      watermark: new Date("2026-05-14T00:00:00Z"),
      lastRunAt: new Date("2026-05-15T00:20:00Z"),
      lastStatus: "success",
      lastError: null,
    });
    const strapi = createMockStrapi();

    const result = await runAnalyticsReconciliationTick(strapi, {
      now: new Date("2026-05-15T10:00:00Z"),
    });

    expect((result as any).stats.reason).toBe("up_to_date");
    expect((result as any).stats.processedDays).toBe(0);
    expect(reconcileCommerceWindowMock).not.toHaveBeenCalled();
  });

  it("counts matched/diverged/matomo_unavailable days and possible currency mismatches", async () => {
    getRefreshStateMock.mockResolvedValue(null);
    reconcileCommerceWindowMock
      .mockResolvedValueOnce({ ...matchedResult(), status: "matched" })
      .mockResolvedValueOnce({ ...matchedResult(), status: "diverged", possibleCurrencyMismatch: true })
      .mockResolvedValueOnce({ ...matchedResult(), status: "matomo_unavailable" });
    const strapi = createMockStrapi();

    const result = await runAnalyticsReconciliationTick(strapi, {
      now: new Date("2026-05-15T10:00:00Z"),
      initialLookbackDays: 3,
      maxDaysPerTick: 7,
    });

    expect((result as any).stats.matchedDays).toBe(1);
    expect((result as any).stats.divergedDays).toBe(1);
    expect((result as any).stats.matomoUnavailableDays).toBe(1);
    expect((result as any).stats.possibleCurrencyMismatchDays).toBe(1);
    expect(strapi.log.warn).toHaveBeenCalledWith(
      "[analyticsReconciliation] possible currency mismatch detected",
      expect.objectContaining({ mismatchCount: 1 }),
    );
  });

  it("marks the run failed and re-throws without advancing the watermark", async () => {
    getRefreshStateMock.mockResolvedValue(null);
    reconcileCommerceWindowMock.mockRejectedValue(new Error("matomo down"));
    const strapi = createMockStrapi();

    const result = await runAnalyticsReconciliationTick(strapi, {
      now: new Date("2026-05-15T10:00:00Z"),
    });

    expect(result.status).toBe("failed");
    expect(markRunFailedMock).toHaveBeenCalledWith(
      expect.anything(),
      "analytics_reconciliation",
      "matomo down",
    );
    expect(markRunSucceededMock).not.toHaveBeenCalled();
  });
});
