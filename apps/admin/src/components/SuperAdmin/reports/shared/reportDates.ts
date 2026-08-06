/**
 * Pure date-only helpers shared by the report workspace. Deliberately has NO
 * dependency on nuqs (unlike useReportQueryState.ts) so components that only need
 * date math — like ReportDateRangeField — don't drag nuqs's ESM-only module into
 * their test/bundle graph just to format a date.
 */

const DAY_MS = 86_400_000;

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
