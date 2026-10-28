import { activityUnit, bucketActivity } from "../activityBuckets";

describe("admin activity buckets", () => {
  it("covers the whole range, filling days the log has nothing for with zeros", () => {
    const { unit, buckets } = bucketActivity(
      [{ date: "2026-09-22", human: 3, automatic: 9 }],
      { start: "2026-09-20", end: "2026-09-25" },
      "2026-09-25",
    );
    expect(unit).toBe("day");
    expect(buckets.map((bucket) => bucket.key)).toEqual([
      "2026-09-20",
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
    ]);
    expect(buckets[2]).toMatchObject({ human: 3, automatic: 9 });
    expect(buckets[0]).toMatchObject({ human: 0, automatic: 0 });
    expect(buckets[5].incomplete).toBe(true);
  });

  it("never cuts a long range to its last days: it buckets it instead", () => {
    const series = Array.from({ length: 120 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10);
      return { date, human: 1, automatic: 2 };
    });
    const { unit, buckets } = bucketActivity(series, { start: "2026-06-01", end: "2026-09-28" }, "2026-09-25");
    expect(unit).toBe("week");
    const total = buckets.reduce((sum, bucket) => sum + bucket.human, 0);
    expect(total).toBe(120);
    // Weeks start on Saturday; 2026-06-01 is a Monday, so the first week is partial.
    expect(buckets[0]).toMatchObject({ key: "2026-05-30", first: "2026-06-01", partial: true });
    expect(buckets[1]).toMatchObject({ key: "2026-06-06", first: "2026-06-06", last: "2026-06-12", partial: false });
  });

  it("goes monthly on the Jalali calendar past half a year", () => {
    expect(activityUnit(62)).toBe("day");
    expect(activityUnit(63)).toBe("week");
    expect(activityUnit(183)).toBe("month");
    const { unit, buckets } = bucketActivity([], { start: "2026-03-21", end: "2026-09-22" }, "2026-09-25");
    expect(unit).toBe("month");
    // 1 Farvardin 1405 = 2026-03-21, so the first month is whole; 31 Shahrivar = 2026-09-22.
    expect(buckets[0]).toMatchObject({ first: "2026-03-21", partial: false });
    expect(buckets.at(-1)).toMatchObject({ last: "2026-09-22", partial: false });
    expect(buckets).toHaveLength(6);
  });

  it("has nothing to show for an empty or inverted range", () => {
    expect(bucketActivity([], { start: "2026-09-25", end: "2026-09-20" }, "2026-09-25").buckets).toEqual([]);
  });
});
