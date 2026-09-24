import {
  bucketSpan,
  comparablePrevious,
  previousWasClipped,
  previousWindow,
  salesSeriesRows,
} from "../salesSeries";

describe("commerce series rows", () => {
  const range = { start: "2026-09-17", end: "2026-09-25" };

  it("names the days a bucket really covers and flags clipped edges", () => {
    // Weeks are Monday-aligned server-side: 14–20 Sep holds only 17–20 of this range.
    expect(bucketSpan("2026-09-14", "week", range)).toEqual({ first: "2026-09-17", last: "2026-09-20", partial: true });
    expect(bucketSpan("2026-09-21", "week", range)).toEqual({ first: "2026-09-21", last: "2026-09-25", partial: true });
    expect(bucketSpan("2026-09-20", "day", range)).toEqual({ first: "2026-09-20", last: "2026-09-20", partial: false });
    expect(bucketSpan("2026-09-01", "month", { start: "2026-09-01", end: "2026-09-30" })).toMatchObject({
      last: "2026-09-30",
      partial: false,
    });
  });

  it("leaves an unknown value as a gap with its reason, and keeps a true zero", () => {
    const rows = salesSeriesRows({
      points: [
        { bucket: "2026-09-24", total: 0, orders: 3 },
        { bucket: "2026-09-25", total: 0, orders: 0 },
      ],
      grouping: "day",
      range: { start: "2026-09-24", end: "2026-09-25" },
      today: "2026-09-25",
      value: (point) => point.total,
      unknownReason: (point) => (point.orders > 0 ? "مبلغ دریافتی ثبت نشده" : null),
    });
    expect(rows[0]).toMatchObject({ current: null, unknownReason: "مبلغ دریافتی ثبت نشده", incomplete: false });
    expect(rows[1]).toMatchObject({ current: 0, unknownReason: null, incomplete: true });
  });

  it("aligns the previous period by position and names its dates", () => {
    const rows = salesSeriesRows({
      points: [{ bucket: "2026-09-24", total: 10 }],
      previousPoints: [{ bucket: "2026-09-22", total: 8 }],
      previousRange: { start: "2026-09-22", end: "2026-09-23" },
      grouping: "day",
      range: { start: "2026-09-24", end: "2026-09-25" },
      today: "2026-09-30",
      value: (point) => point.total,
    });
    expect(rows[0]).toMatchObject({ current: 10, previous: 8 });
    expect(rows[0].previousTitle).toBeTruthy();
  });
});

describe("previous period", () => {
  it("is the equal-length window just before", () => {
    expect(previousWindow({ start: "2026-09-20", end: "2026-09-25" })).toEqual({ start: "2026-09-14", end: "2026-09-19" });
  });

  it("is not comparable when it starts before the sales data floor", () => {
    expect(comparablePrevious({ start: "2026-09-20", end: "2026-09-25" })).toEqual({ start: "2026-09-14", end: "2026-09-19" });
    expect(comparablePrevious({ start: "2026-09-15", end: "2026-09-25" })).toBeNull();
  });

  it("detects a previous window the server clamped to the floor", () => {
    const range = { start: "2026-09-15", end: "2026-09-25" };
    expect(previousWasClipped(range, { start: "2026-09-14", end: "2026-09-14" })).toBe(true);
    expect(previousWasClipped(range, { start: "2026-09-14", end: "2026-09-13" })).toBe(true);
    expect(previousWasClipped({ start: "2026-09-20", end: "2026-09-25" }, { start: "2026-09-14", end: "2026-09-19" })).toBe(false);
    expect(previousWasClipped(range, null)).toBe(true);
  });
});
