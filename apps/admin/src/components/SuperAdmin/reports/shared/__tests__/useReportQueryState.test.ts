// This file only exercises the pure toDateOnly/parseDateOnly helpers, but importing
// the module pulls in "nuqs" (ESM-only, breaks under this repo's current Jest
// transform config) — mocked out here rather than touching the shared Jest config.
jest.mock("nuqs", () => ({
  parseAsString: { withDefault: (v: unknown) => v },
  useQueryState: () => ["", jest.fn()],
  useQueryStates: () => [{}, jest.fn()],
}));

import {
  toDateOnly,
  parseDateOnly,
  defaultReportStart,
  defaultReportEnd,
  isReportDateOnly,
  sanitizeReportRange,
} from "../useReportQueryState";
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

describe("isReportDateOnly", () => {
  it("accepts a plain calendar day", () => {
    expect(isReportDateOnly("2026-07-23")).toBe(true);
  });

  it("rejects the shapes the backend also rejects", () => {
    // The report API matches /^\d{4}-\d{2}-\d{2}$/ exactly; a time component or an
    // ISO suffix is a 400 there, so it must never leave the client.
    expect(isReportDateOnly("2026-07-23T00:00:00.000Z")).toBe(false);
    expect(isReportDateOnly("2026-7-3")).toBe(false);
    expect(isReportDateOnly("banana")).toBe(false);
    expect(isReportDateOnly("")).toBe(false);
  });

  it("rejects a day that doesn't exist rather than letting Date roll it forward", () => {
    expect(isReportDateOnly("2026-02-31")).toBe(false);
    expect(isReportDateOnly("2026-13-01")).toBe(false);
  });
});

describe("sanitizeReportRange", () => {
  it("passes a valid range through untouched", () => {
    expect(sanitizeReportRange("2026-07-23", "2026-08-22")).toEqual({
      start: "2026-07-23",
      end: "2026-08-22",
    });
  });

  it("replaces a malformed side with that side's default", () => {
    // start/end are plain nuqs strings, so a hand-edited or truncated URL can put
    // anything here. Sending it on used to mean either silently-wrong numbers
    // (sales endpoints substituted today) or an error banner (behavior endpoints).
    expect(sanitizeReportRange("banana", "2026-08-22")).toEqual({
      start: defaultReportStart(),
      end: "2026-08-22",
    });
    expect(sanitizeReportRange("2026-07-23", "")).toEqual({
      start: "2026-07-23",
      end: defaultReportEnd(),
    });
  });

  it("swaps a reversed range instead of forwarding an impossible window", () => {
    expect(sanitizeReportRange("2026-08-22", "2026-07-23")).toEqual({
      start: "2026-07-23",
      end: "2026-08-22",
    });
  });

  it("still yields a usable range when both sides are junk", () => {
    const range = sanitizeReportRange("??", "??");
    expect(isReportDateOnly(range.start)).toBe(true);
    expect(isReportDateOnly(range.end)).toBe(true);
    expect(range.start <= range.end).toBe(true);
  });
});
