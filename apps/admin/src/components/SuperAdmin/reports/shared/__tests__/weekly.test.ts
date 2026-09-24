import { HEAT_RAMP, buildWeekly, heatStep, hoursShare } from "../weekly";

describe("weekday × hour grid", () => {
  const grid = (fill: (dow: number, hour: number) => number) =>
    Array.from({ length: 7 }, (_, dow) => Array.from({ length: 24 }, (_, hour) => fill(dow, hour)));

  it("starts the week on Saturday and averages per occurrence of each weekday", () => {
    // Friday (dow 5) has the largest sum only because the range held five of them.
    const weekly = buildWeekly({
      sessions: grid((dow, hour) => (hour === 21 ? (dow === 5 ? 500 : dow === 3 ? 480 : 100) : 10)),
      days: [4, 4, 4, 4, 4, 5, 4],
    })!;
    expect(weekly.days.map((day) => day.label)).toEqual([
      "شنبه",
      "یکشنبه",
      "دوشنبه",
      "سه‌شنبه",
      "چهارشنبه",
      "پنجشنبه",
      "جمعه",
    ]);
    const friday = weekly.days[6];
    expect(friday.cells[21]).toMatchObject({ total: 500, average: 100 });
    // Wednesday: 480 over four days beats Friday's 500 over five.
    expect(weekly.peak).toMatchObject({ dow: 3, hour: 21, average: 120 });
    expect(weekly.max).toBe(120);
  });

  it("marks weekdays the range did not contain as missing, not as zero", () => {
    const weekly = buildWeekly({ sessions: grid(() => 0), days: [1, 1, 0, 0, 0, 0, 0] })!;
    const monday = weekly.days.find((day) => day.dow === 1)!;
    const tuesday = weekly.days.find((day) => day.dow === 2)!;
    expect(monday.cells[3].average).toBe(0);
    expect(tuesday.cells[3].average).toBeNull();
    expect(tuesday.hourlyMean).toBeNull();
  });

  it("refuses a malformed or missing grid", () => {
    expect(buildWeekly(undefined)).toBeNull();
    expect(buildWeekly({ sessions: [[1]], days: [1, 1, 1, 1, 1, 1, 1] })).toBeNull();
    expect(buildWeekly({ sessions: grid(() => 1), days: [1] })).toBeNull();
  });

  it("reads the commerce and audit grids (`counts`) as well as Umami's (`sessions`)", () => {
    const weekly = buildWeekly({ counts: grid((dow, hour) => (dow === 5 && hour === 22 ? 12 : 0)), days: [1, 1, 1, 1, 1, 2, 1] })!;
    expect(weekly.peak).toMatchObject({ dow: 5, hour: 22, average: 6 });
    expect(weekly.total).toBe(12);
  });

  it("gives the share of events inside a set of hours", () => {
    const weekly = buildWeekly({
      counts: grid((_, hour) => (hour === 23 ? 1 : hour === 10 ? 3 : 0)),
      days: [1, 1, 1, 1, 1, 1, 1],
    })!;
    expect(hoursShare(weekly, [22, 23, 0, 1, 2, 3, 4, 5, 6])).toBeCloseTo(0.25);
    expect(hoursShare(buildWeekly({ counts: grid(() => 0), days: [1, 1, 1, 1, 1, 1, 1] })!, [23])).toBeNull();
  });

  it("uses the lightest step only for a true zero", () => {
    expect(heatStep(null, 10)).toBeNull();
    expect(heatStep(0, 10)).toBe(0);
    expect(heatStep(0.1, 10)).toBe(1);
    expect(heatStep(10, 10)).toBe(HEAT_RAMP.length - 1);
  });
});
