// This file only exercises the pure toDateOnly/parseDateOnly helpers, but importing
// the module pulls in "nuqs" (ESM-only, breaks under this repo's current Jest
// transform config) — mocked out here rather than touching the shared Jest config.
jest.mock("nuqs", () => ({
  parseAsString: { withDefault: (v: unknown) => v },
  useQueryState: () => ["", jest.fn()],
  useQueryStates: () => [{}, jest.fn()],
}));

import { toDateOnly, parseDateOnly, defaultReportStart, defaultReportEnd } from "../useReportQueryState";
import {
  jalaliBirthDateToGregorianDate,
} from "@/utils/birthDate";
import {
  jalaliPartsInTehran,
  previousJalaliMonthRange,
  thisJalaliMonthRange,
} from "../reportDates";

describe("toDateOnly / parseDateOnly", () => {
  it("round-trips a local date without shifting days", () => {
    const d = new Date(2026, 0, 1); // local Jan 1, 2026 midnight
    expect(toDateOnly(d)).toBe("2026-01-01");
    expect(toDateOnly(parseDateOnly(toDateOnly(d)))).toBe("2026-01-01");
  });

  it("parseDateOnly builds a LOCAL midnight Date, not a UTC one (the bug this guards against)", () => {
    // The bug: `new Date("2026-01-01")` parses as UTC midnight, which serializes back
    // via `.toISOString().slice(0,10)` correctly only in UTC — but reading it back
    // through LOCAL getters (as every calendar UI in this app does) rolls back a day
    // in any timezone ahead of UTC. parseDateOnly must avoid the UTC-parse path entirely.
    const parsed = parseDateOnly("2026-06-15");
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(5);
    expect(parsed.getDate()).toBe(15);
    expect(parsed.getHours()).toBe(0);
  });

  it("pads single-digit months/days", () => {
    expect(toDateOnly(new Date(2026, 2, 5))).toBe("2026-03-05");
  });

  it("defaultReportStart/End are well-formed yyyy-mm-dd strings", () => {
    expect(defaultReportStart()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(defaultReportEnd()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("Jalali month presets", () => {
  const noonTehran = new Date("2026-09-09T08:30:00.000Z");

  it("این ماه starts on Jalali day 1 of the current Tehran month", () => {
    const parts = jalaliPartsInTehran(noonTehran);
    expect(parts).not.toBeNull();
    if (!parts) return;
    const range = thisJalaliMonthRange(noonTehran);
    expect(toDateOnly(range.start)).toBe(
      jalaliBirthDateToGregorianDate(parts.year, parts.month, 1),
    );
    expect(toDateOnly(range.end)).toBe(toDateOnly(noonTehran));
  });

  it("ماه گذشته is the full previous Jalali month", () => {
    const parts = jalaliPartsInTehran(noonTehran);
    expect(parts).not.toBeNull();
    if (!parts) return;
    const prevMonth = parts.month === 1 ? 12 : parts.month - 1;
    const prevYear = parts.month === 1 ? parts.year - 1 : parts.year;
    const range = previousJalaliMonthRange(noonTehran);
    expect(toDateOnly(range.start)).toBe(
      jalaliBirthDateToGregorianDate(prevYear, prevMonth, 1),
    );
    expect(toDateOnly(range.end)).toBe(
      toDateOnly(
        new Date(
          thisJalaliMonthRange(noonTehran).start.getFullYear(),
          thisJalaliMonthRange(noonTehran).start.getMonth(),
          thisJalaliMonthRange(noonTehran).start.getDate() - 1,
        ),
      ),
    );
  });
});
