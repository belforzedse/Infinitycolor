import { tehranDayBounds } from "../businessTime";

describe("Tehran business-day boundaries", () => {
  it.each([
    ["2026-09-11T20:29:59.999Z", "2026-09-10T20:30:00.000Z", "2026-09-11T20:30:00.000Z"],
    ["2026-09-11T20:30:00.000Z", "2026-09-11T20:30:00.000Z", "2026-09-12T20:30:00.000Z"],
  ])("bounds %s by the Tehran calendar day", (now, start, end) => {
    expect(tehranDayBounds(new Date(now))).toEqual({
      start: new Date(start),
      end: new Date(end),
    });
  });
});
