/**
 * Pure date-only helpers shared by the report workspace. Deliberately has NO
 * dependency on nuqs (unlike useReportQueryState.ts) so components that only need
 * date math — like ReportDateRangeField — don't drag nuqs's ESM-only module into
 * their test/bundle graph just to format a date.
 */

import { jalaliBirthDateToGregorianDate } from "@/utils/birthDate";

const DAY_MS = 86_400_000;
const REPORT_TIMEZONE = "Asia/Tehran";
const PERSIAN_CALENDAR_LOCALE = "en-US-u-ca-persian";

/** yyyy-mm-dd in the local calendar (kept simple; backend bucketing handles tz). */
export function toDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Inverse of {@link toDateOnly}: builds a LOCAL midnight Date from a "yyyy-mm-dd"
 * string. Deliberately NOT `new Date(str)` — the native constructor parses a
 * date-only string as UTC midnight, which renders as the previous day in any
 * timezone behind UTC.
 */
export function parseDateOnly(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

export function defaultReportStart(days = 30): string {
  return toDateOnly(new Date(Date.now() - days * DAY_MS));
}

export function defaultReportEnd(): string {
  return toDateOnly(new Date());
}

export type JalaliYmd = { year: number; month: number; day: number };

/** Jalali Y/M/D of `date` as seen in Tehran, matching backend report buckets. */
export function jalaliPartsInTehran(date: Date): JalaliYmd | null {
  const parts = new Intl.DateTimeFormat(PERSIAN_CALENDAR_LOCALE, {
    timeZone: REPORT_TIMEZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  if (!year || !month || !day) return null;
  return { year, month, day };
}

function gregorianDateFromJalali(
  year: number,
  month: number,
  day: number,
): Date | null {
  const ymd = jalaliBirthDateToGregorianDate(year, month, day);
  return ymd ? parseDateOnly(ymd) : null;
}

function previousJalaliMonth(parts: JalaliYmd): { year: number; month: number } {
  if (parts.month === 1) return { year: parts.year - 1, month: 12 };
  return { year: parts.year, month: parts.month - 1 };
}

/**
 * Jalali «این ماه»: 1st of the current Persian month through `now`.
 * Falls back to the Gregorian month if Intl cannot produce Jalali parts.
 */
export function thisJalaliMonthRange(now = new Date()): { start: Date; end: Date } {
  const parts = jalaliPartsInTehran(now);
  if (!parts) {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
  }
  const start = gregorianDateFromJalali(parts.year, parts.month, 1);
  return { start: start ?? now, end: now };
}

/**
 * Jalali «ماه گذشته»: the full previous Persian month.
 * Falls back to the Gregorian previous month if Intl cannot produce Jalali parts.
 */
export function previousJalaliMonthRange(
  now = new Date(),
): { start: Date; end: Date } {
  const parts = jalaliPartsInTehran(now);
  if (!parts) {
    return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      end: new Date(now.getFullYear(), now.getMonth(), 0),
    };
  }
  const previous = previousJalaliMonth(parts);
  const start = gregorianDateFromJalali(previous.year, previous.month, 1);
  const thisMonthStart = gregorianDateFromJalali(parts.year, parts.month, 1);
  const end = thisMonthStart
    ? new Date(
        thisMonthStart.getFullYear(),
        thisMonthStart.getMonth(),
        thisMonthStart.getDate() - 1,
      )
    : now;
  return { start: start ?? now, end };
}
