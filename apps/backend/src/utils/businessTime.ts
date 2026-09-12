export const BUSINESS_TIMEZONE = "Asia/Tehran";

// Keep this aligned with the reporting subsystem's existing Tehran boundary
// contract so operational and reporting day totals agree.
const TEHRAN_UTC_OFFSET = "+03:30";

function tehranDateParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function calendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** UTC instants bounding the current Tehran calendar day as a half-open range. */
export function tehranDayBounds(now = new Date()): { start: Date; end: Date } {
  const { year, month, day } = tehranDateParts(now);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const start = new Date(`${calendarDate(year, month, day)}T00:00:00.000${TEHRAN_UTC_OFFSET}`);
  const end = new Date(
    `${calendarDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())}T00:00:00.000${TEHRAN_UTC_OFFSET}`,
  );
  return { start, end };
}
