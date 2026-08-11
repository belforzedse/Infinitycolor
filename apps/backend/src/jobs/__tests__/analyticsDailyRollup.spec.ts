/**
 * Orchestration tests for the analytics daily rollup job: watermark-window
 * computation, tick capping (backfill safety), the "already up to date" skip, and
 * failure bookkeeping. The SQL each source function issues is covered separately in
 * src/api/report/analytics/__tests__/{commerce,refreshState}.spec.ts — this file
 * mocks those functions to isolate the job's own control flow.
 */

const resolveJoinsMock = jest.fn().mockResolvedValue({});
const getDailySalesRollupRowsMock = jest.fn();
const getProductDailyRollupRowsMock = jest.fn();
const upsertDailySalesRowsMock = jest.fn().mockResolvedValue(undefined);
const upsertProductDailyRowsMock = jest.fn().mockResolvedValue(undefined);
const getRefreshStateMock = jest.fn();
const markRunStartedMock = jest.fn().mockResolvedValue(undefined);
const markRunSucceededMock = jest.fn().mockResolvedValue(undefined);
const markRunFailedMock = jest.fn().mockResolvedValue(undefined);

jest.mock("../../api/report/services/product-analytics", () => ({
  resolveJoins: (...args: any[]) => resolveJoinsMock(...args),
}));

jest.mock("../../api/report/analytics/sources/commerce", () => ({
  getDailySalesRollupRows: (...args: any[]) => getDailySalesRollupRowsMock(...args),
  getProductDailyRollupRows: (...args: any[]) => getProductDailyRollupRowsMock(...args),
  upsertDailySalesRows: (...args: any[]) => upsertDailySalesRowsMock(...args),
  upsertProductDailyRows: (...args: any[]) => upsertProductDailyRowsMock(...args),
}));

jest.mock("../../api/report/analytics/sources/refreshState", () => ({
  getRefreshState: (...args: any[]) => getRefreshStateMock(...args),
  markRunStarted: (...args: any[]) => markRunStartedMock(...args),
  markRunSucceeded: (...args: any[]) => markRunSucceededMock(...args),
  markRunFailed: (...args: any[]) => markRunFailedMock(...args),
}));

import { __resetBackgroundJobGuardsForTests } from "../backgroundJobRunner";
import { runAnalyticsDailyRollupTick } from "../analyticsDailyRollup";

function createMockStrapi() {
  return {
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    db: { connection: {} },
  } as any;
}

describe("runAnalyticsDailyRollupTick", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveJoinsMock.mockResolvedValue({});
    getDailySalesRollupRowsMock.mockResolvedValue([]);
    getProductDailyRollupRowsMock.mockResolvedValue([]);
    __resetBackgroundJobGuardsForTests();
  });

  it("first run (no watermark): seeds the configured initial lookback window ending yesterday", async () => {
    getRefreshStateMock.mockResolvedValue(null);
    const strapi = createMockStrapi();

    const result = await runAnalyticsDailyRollupTick(strapi, {
      now: new Date("2026-05-15T10:00:00Z"), // Tehran-local: 2026-05-15 13:30
      initialLookbackDays: 5,
      maxDaysPerTick: 31,
    });

    expect(result.status).toBe("completed");
    expect((result as any).stats.startDay).toBe("2026-05-10");
    expect((result as any).stats.endDay).toBe("2026-05-14"); // yesterday, Tehran-local
    expect((result as any).stats.processedDays).toBe(5);
    expect(markRunSucceededMock).toHaveBeenCalledWith(
      expect.anything(),
      "analytics_daily_rollup",
      new Date("2026-05-14T00:00:00Z"),
    );
  });

  it("resumes from the watermark, not from the lookback default", async () => {
    getRefreshStateMock.mockResolvedValue({
      sourceType: "analytics_daily_rollup",
      watermark: new Date("2026-05-12T00:00:00Z"),
      lastRunAt: new Date("2026-05-13T00:20:00Z"),
      lastStatus: "success",
      lastError: null,
    });
    const strapi = createMockStrapi();

    const result = await runAnalyticsDailyRollupTick(strapi, {
      now: new Date("2026-05-15T10:00:00Z"),
      initialLookbackDays: 30,
      maxDaysPerTick: 31,
    });

    expect((result as any).stats.startDay).toBe("2026-05-13");
    expect((result as any).stats.endDay).toBe("2026-05-14");
    expect((result as any).stats.processedDays).toBe(2);
  });

  it("caps a large backfill at maxDaysPerTick so a single tick stays bounded", async () => {
    getRefreshStateMock.mockResolvedValue({
      sourceType: "analytics_daily_rollup",
      watermark: new Date("2026-01-01T00:00:00Z"),
      lastRunAt: null,
      lastStatus: "success",
      lastError: null,
    });
    const strapi = createMockStrapi();

    const result = await runAnalyticsDailyRollupTick(strapi, {
      now: new Date("2026-06-01T10:00:00Z"),
      initialLookbackDays: 30,
      maxDaysPerTick: 10,
    });

    expect((result as any).stats.startDay).toBe("2026-01-02");
    expect((result as any).stats.endDay).toBe("2026-01-11"); // 10-day cap, well short of "yesterday"
    expect((result as any).stats.processedDays).toBe(10);
  });

  it("is a no-op when the watermark is already at yesterday", async () => {
    getRefreshStateMock.mockResolvedValue({
      sourceType: "analytics_daily_rollup",
      watermark: new Date("2026-05-14T00:00:00Z"),
      lastRunAt: new Date("2026-05-15T00:20:00Z"),
      lastStatus: "success",
      lastError: null,
    });
    const strapi = createMockStrapi();

    const result = await runAnalyticsDailyRollupTick(strapi, {
      now: new Date("2026-05-15T10:00:00Z"),
    });

    expect((result as any).stats.reason).toBe("up_to_date");
    expect((result as any).stats.processedDays).toBe(0);
    expect(getDailySalesRollupRowsMock).not.toHaveBeenCalled();
    expect(upsertDailySalesRowsMock).not.toHaveBeenCalled();
  });

  it("trims rows outside [startDay, endDay] before upserting (over-fetch slack)", async () => {
    getRefreshStateMock.mockResolvedValue(null);
    getDailySalesRollupRowsMock.mockResolvedValue([
      { bucketDate: "2026-05-09", grossToman: 1 }, // before window (slack)
      { bucketDate: "2026-05-10", grossToman: 2 }, // in window
      { bucketDate: "2026-05-14", grossToman: 3 }, // in window
      { bucketDate: "2026-05-15", grossToman: 4 }, // after window (slack)
    ]);
    const strapi = createMockStrapi();

    await runAnalyticsDailyRollupTick(strapi, {
      now: new Date("2026-05-15T10:00:00Z"),
      initialLookbackDays: 5,
      maxDaysPerTick: 31,
    });

    expect(upsertDailySalesRowsMock).toHaveBeenCalledWith(expect.anything(), [
      { bucketDate: "2026-05-10", grossToman: 2 },
      { bucketDate: "2026-05-14", grossToman: 3 },
    ]);
  });

  it("marks the run failed and re-throws (surfacing through runBackgroundJob) without advancing the watermark", async () => {
    getRefreshStateMock.mockResolvedValue(null);
    getDailySalesRollupRowsMock.mockRejectedValue(new Error("db exploded"));
    const strapi = createMockStrapi();

    await expect(
      runAnalyticsDailyRollupTick(strapi, { now: new Date("2026-05-15T10:00:00Z") }),
    ).rejects.toThrow("db exploded");
    expect(markRunFailedMock).toHaveBeenCalledWith(
      expect.anything(),
      "analytics_daily_rollup",
      "db exploded",
    );
    expect(markRunSucceededMock).not.toHaveBeenCalled();
  });
});
