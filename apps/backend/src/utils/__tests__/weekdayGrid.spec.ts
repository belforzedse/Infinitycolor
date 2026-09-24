import { weekdayCounts, weekdayGrid } from "../weekdayGrid";

describe("weekday grid", () => {
  it("counts each weekday in an inclusive window", () => {
    // 2026-09-14 is a Monday; 14–20 Sep holds one of each.
    expect(weekdayCounts("2026-09-14", "2026-09-20")).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(weekdayCounts("2026-09-14", "2026-09-22")).toEqual([1, 2, 2, 1, 1, 1, 1]);
    expect(weekdayCounts("2026-09-20", "2026-09-14")).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("folds rows into a full 7×24 grid and ignores rows outside it", () => {
    const grid = weekdayGrid(
      [
        { dow: 5, hour: 22, count: "3" },
        { dow: "5", hour: "22", count: 2 },
        { dow: 7, hour: 1, count: 9 },
        { dow: 1, hour: 24, count: 9 },
      ],
      "2026-09-14",
      "2026-09-20",
      "Asia/Tehran",
    );
    expect(grid.counts).toHaveLength(7);
    expect(grid.counts.every((row) => row.length === 24)).toBe(true);
    expect(grid.counts[5][22]).toBe(5);
    expect(grid.counts.flat().reduce((a, b) => a + b, 0)).toBe(5);
    expect(grid).toMatchObject({ timezone: "Asia/Tehran", firstDay: "sunday", days: [1, 1, 1, 1, 1, 1, 1] });
  });
});
