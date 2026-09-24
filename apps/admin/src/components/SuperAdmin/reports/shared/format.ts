/**
 * Number, date and change formatting for every report page. Every helper
 * takes `unknown` and answers «—» for a missing value, so a gap in the data is
 * never printed as a zero. Numbers use Persian digits and grouping; dates are
 * Jalali, in Tehran time. Money pages that already format with
 * `priceFormatter` keep doing so; these are the Intl equivalents for charts.
 */

const TEHRAN = "Asia/Tehran";
/** Persian digits on the Jalali calendar, stated explicitly rather than implied by `fa-IR`. */
const FA_DATE = "fa-IR-u-ca-persian";
export const MISSING = "—";

export function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatter(options: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat("fa-IR", options);
}

export function numberText(value: unknown, maximumFractionDigits = 0): string {
  const parsed = finite(value);
  return parsed === null ? MISSING : formatter({ maximumFractionDigits }).format(parsed);
}

/** Axis ticks and headline money: «۱۲٫۴ هزار», «۳٫۱ میلیون». */
export function compactNumber(value: unknown, fractionDigits = 1): string {
  const parsed = finite(value);
  if (parsed === null) return MISSING;
  const absolute = Math.abs(parsed);
  const digits = formatter({ maximumFractionDigits: fractionDigits });
  if (absolute >= 1_000_000_000) return `${digits.format(parsed / 1_000_000_000)} میلیارد`;
  if (absolute >= 1_000_000) return `${digits.format(parsed / 1_000_000)} میلیون`;
  if (absolute >= 10_000) return `${digits.format(parsed / 1_000)} هزار`;
  return formatter({ maximumFractionDigits: 0 }).format(parsed);
}

/** A value already in percent (0–100). */
export function percentText(value: unknown, maximumFractionDigits = 1): string {
  const parsed = finite(value);
  return parsed === null
    ? MISSING
    : `${formatter({ maximumFractionDigits }).format(parsed)}٪`;
}

/** A ratio (0–1) shown as a percent. Small rates keep two decimals. */
export function ratioText(ratio: unknown): string {
  const parsed = finite(ratio);
  if (parsed === null) return MISSING;
  const percent = parsed * 100;
  return percentText(percent, percent !== 0 && Math.abs(percent) < 1 ? 2 : 1);
}

export function tomanText(value: unknown): string {
  const parsed = finite(value);
  return parsed === null
    ? MISSING
    : `${formatter({ maximumFractionDigits: 0 }).format(parsed)} تومان`;
}

export function durationText(seconds: unknown): string {
  const parsed = finite(seconds);
  if (parsed === null) return MISSING;
  const total = Math.max(0, Math.round(parsed));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  const n = (value: number) => formatter({}).format(value);
  return minutes ? `${n(minutes)} دقیقه و ${n(remainder)} ثانیه` : `${n(remainder)} ثانیه`;
}

/** Relative change in percent, or null when there is no meaningful base. */
export function relativeChange(current: unknown, previous: unknown): number | null {
  const now = finite(current);
  const before = finite(previous);
  if (now === null || before === null || before === 0) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

/** Difference of two ratios (0–1) in percentage points. */
export function pointChange(current: unknown, previous: unknown): number | null {
  const now = finite(current);
  const before = finite(previous);
  if (now === null || before === null) return null;
  return (now - before) * 100;
}

const signed = (maximumFractionDigits: number) =>
  formatter({ maximumFractionDigits, signDisplay: "exceptZero" });

/** «+۱۲٫۳٪» — a relative change. */
export function signedPercentText(change: number): string {
  return `${signed(1).format(change)}٪`;
}

/** «+۲٫۱ واحد درصد» — a change between two rates. */
export function signedPointsText(points: number): string {
  return `${signed(Math.abs(points) < 1 ? 2 : 1).format(points)} واحد درصد`;
}

function tehranNoon(ymd: string): Date {
  return new Date(`${ymd}T12:00:00+03:30`);
}

export function isDateOnly(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** «۱۲ مهر ۱۴۰۵» for a `YYYY-MM-DD` Tehran date. */
export function dateText(ymd: unknown, withYear = true): string {
  if (!isDateOnly(ymd)) return MISSING;
  return tehranNoon(ymd).toLocaleDateString(FA_DATE, {
    timeZone: TEHRAN,
    day: "numeric",
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

/**
 * «شنبه ۲۹ شهریور ۱۴۰۵»: a day with its weekday, for tooltips. Composed from
 * parts because ICU's Persian pattern for this set of fields reads
 * «۱۴۰۵ شهریور ۲۹, شنبه», year first with a Latin comma.
 */
export function weekdayDateText(ymd: unknown): string {
  if (!isDateOnly(ymd)) return MISSING;
  const weekday = tehranNoon(ymd).toLocaleDateString(FA_DATE, { timeZone: TEHRAN, weekday: "long" });
  return `${weekday} ${dateText(ymd)}`;
}

/** Adds whole days to a `YYYY-MM-DD` date. */
export function addDays(ymd: string, days: number): string {
  const date = tehranNoon(ymd);
  date.setUTCDate(date.getUTCDate() + days);
  return tehranToday(date);
}

export function rangeText(start: unknown, end: unknown): string {
  if (!isDateOnly(start) || !isDateOnly(end)) return MISSING;
  return start === end ? dateText(start) : `${dateText(start, false)} تا ${dateText(end)}`;
}

export type BucketUnit = "hour" | "day" | "week" | "month";

/** A trend bucket key (`YYYY-MM-DD`, `YYYY-MM-DD HH` or `YYYY-MM`) as a short axis label. */
export function bucketText(t: string, unit: BucketUnit): string {
  if (unit === "hour") {
    const hour = Number(t.slice(11, 13));
    return `${dateText(t.slice(0, 10), false)}، ${formatter({}).format(hour)}:۰۰`;
  }
  if (unit === "month") {
    return tehranNoon(`${t.slice(0, 7)}-15`).toLocaleDateString(FA_DATE, {
      timeZone: TEHRAN,
      month: "long",
      year: "numeric",
    });
  }
  return dateText(t.slice(0, 10), false);
}

/**
 * The days a bucket covers, for tooltips: «۲۴ تا ۳۰ شهریور ۱۴۰۵». Week and
 * month buckets are named by their span rather than a month name, because a
 * calendar-month bucket spans two Jalali months.
 */
export function bucketSpanText(first: string, last: string): string {
  if (!isDateOnly(first) || !isDateOnly(last)) return MISSING;
  return first === last ? weekdayDateText(first) : rangeText(first, last);
}

export function dateTimeText(value?: string | null): string {
  if (!value) return "نامشخص";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString(FA_DATE, { timeZone: TEHRAN })
    : "نامشخص";
}

/** Today's `YYYY-MM-DD` in Tehran, the zone every report bucket uses. */
export function tehranToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TEHRAN,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
