import { LEGACY_SALES_DATA_CUTOFF } from "./reportDates";
import { addDays, bucketSpanText, dateText, finite, toTehranYmd } from "./format";
import type { SeriesRow } from "./TimeSeriesChart";

/** How the commerce reports bucket a series (Tehran calendar; weeks start Monday server-side). */
export type SalesGrouping = "day" | "week" | "month";

export type DateRange = { start: string; end: string };

function lastDayOfMonth(ymd: string): string {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7));
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
}

/**
 * The days a bucket actually covers inside the range. A week or month bucket
 * at either edge of the range holds only part of its days; `partial` says so
 * rather than letting a short bucket read as a slump.
 */
export function bucketSpan(
  bucket: string,
  grouping: SalesGrouping,
  range: DateRange,
): { first: string; last: string; partial: boolean } {
  const start = bucket.slice(0, 10);
  const end = grouping === "day" ? start : grouping === "week" ? addDays(start, 6) : lastDayOfMonth(start);
  const first = start < range.start ? range.start : start;
  const last = end > range.end ? range.end : end;
  return { first, last, partial: first !== start || last !== end };
}

/** The equal-length window just before a range: what «دوره قبل» means everywhere. */
export function previousWindow(range: DateRange): DateRange {
  const days = Math.round((Date.parse(`${range.end}T12:00:00Z`) - Date.parse(`${range.start}T12:00:00Z`)) / 86_400_000);
  const end = addDays(range.start, -1);
  return { start: addDays(end, -days), end };
}

/**
 * Sales data starts at the storefront cutover. A previous window that begins
 * before it holds fewer days than it claims, so it cannot be compared.
 */
export function comparablePrevious(range: DateRange): DateRange | null {
  const previous = previousWindow(range);
  return previous.start >= LEGACY_SALES_DATA_CUTOFF ? previous : null;
}

/**
 * The server clamps the previous window to the data floor. When what it used
 * differs from the full equal-length window, the delta would compare unequal
 * spans: callers show why there is no comparison instead.
 */
export function previousWasClipped(
  range: Partial<DateRange> | null | undefined,
  previous: Partial<DateRange> | null | undefined,
): boolean {
  // Endpoints echo their windows as calendar dates or as full instants.
  const start = toTehranYmd(range?.start);
  const end = toTehranYmd(range?.end);
  const previousStart = toTehranYmd(previous?.start);
  const previousEnd = toTehranYmd(previous?.end);
  if (!start || !end || !previousStart || !previousEnd || start > end) return true;
  const full = previousWindow({ start, end });
  return previousStart > previousEnd || previousStart !== full.start || previousEnd !== full.end;
}

export const NO_COMPARISON_BEFORE_FLOOR = "بدون مقایسه: دوره قبل پیش از ۲۳ شهریور است";

/**
 * Chart rows for a commerce series. Each bucket gets its real date span, an
 * open bucket (it contains today) is flagged, a clipped edge bucket is
 * flagged, and a value the caller marks unknown becomes a gap with its reason
 * instead of a zero. The previous period is aligned by position.
 */
export function salesSeriesRows<P extends { bucket: string }>({
  points,
  grouping,
  range,
  today,
  value,
  unknownReason,
  note,
  previousPoints,
  previousRange,
}: {
  points: ReadonlyArray<P>;
  grouping: SalesGrouping;
  range: DateRange;
  today: string;
  value: (point: P) => unknown;
  unknownReason?: (point: P) => string | null;
  note?: (point: P) => string | null;
  previousPoints?: ReadonlyArray<P> | null;
  previousRange?: DateRange | null;
}): SeriesRow[] {
  return points.map((point, index) => {
    const span = bucketSpan(point.bucket, grouping, range);
    const reason = unknownReason?.(point) ?? null;
    const previousPoint = previousPoints?.[index];
    const previousSpan =
      previousPoint && previousRange ? bucketSpan(previousPoint.bucket, grouping, previousRange) : null;
    return {
      key: point.bucket,
      label: dateText(span.first, false),
      title: bucketSpanText(span.first, span.last),
      current: reason ? null : finite(value(point)),
      unknownReason: reason,
      note: reason ? null : (note?.(point) ?? null),
      incomplete: span.first <= today && today <= span.last,
      flag: span.partial ? "بخشی از بازه" : null,
      previous: previousPoint ? finite(value(previousPoint)) : null,
      previousTitle: previousSpan ? bucketSpanText(previousSpan.first, previousSpan.last) : null,
    };
  });
}
