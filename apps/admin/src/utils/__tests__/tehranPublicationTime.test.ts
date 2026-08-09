import {
  formatTehranPublication,
  instantToTehranWallTime,
  pickerToTehranIso,
  tehranWallTimeToUtcIso,
} from "../tehranPublicationTime";

describe("Tehran product publication time", () => {
  it("serializes Tehran wall time to a canonical UTC instant", () => {
    expect(tehranWallTimeToUtcIso({
      year: 2026,
      month: 9,
      day: 1,
      hour: 12,
      minute: 0,
    })).toBe("2026-09-01T08:30:00.000Z");
  });

  it("round-trips persisted UTC without using the browser timezone", () => {
    expect(instantToTehranWallTime("2026-09-01T08:30:00.000Z")).toEqual({
      year: 2026,
      month: 9,
      day: 1,
      hour: 12,
      minute: 0,
    });
  });

  it("reads picker calendar components as an explicit Tehran wall clock", () => {
    const pickerDate = new Date(2026, 8, 1, 0, 0, 0, 0);
    expect(pickerToTehranIso(pickerDate, 12, 0)).toBe("2026-09-01T08:30:00.000Z");
  });

  it("formats the exact persisted instant in Persian Tehran time", () => {
    const formatted = formatTehranPublication("2026-09-01T08:30:00.000Z");
    expect(formatted).toContain("۱۲:۰۰");
  });
});
