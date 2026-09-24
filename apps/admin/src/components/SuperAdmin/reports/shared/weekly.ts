import { finite } from "./format";
import { SEQUENTIAL_RAMP } from "./chartTheme";

/** Saturday-first Persian week; the grids arrive Sunday-first (Postgres `dow`). */
export const PERSIAN_WEEK: ReadonlyArray<{ dow: number; label: string }> = [
  { dow: 6, label: "شنبه" },
  { dow: 0, label: "یکشنبه" },
  { dow: 1, label: "دوشنبه" },
  { dow: 2, label: "سه‌شنبه" },
  { dow: 3, label: "چهارشنبه" },
  { dow: 4, label: "پنجشنبه" },
  { dow: 5, label: "جمعه" },
];

export const HEAT_RAMP = SEQUENTIAL_RAMP;

export type WeeklyCell = {
  dow: number;
  hour: number;
  /** Events in this hour, summed over the range. */
  total: number;
  /** Per such weekday in the range; null when the range held none of it. */
  average: number | null;
};

export type WeeklyView = {
  days: Array<{ dow: number; label: string; observedDays: number; cells: WeeklyCell[]; hourlyMean: number | null }>;
  /** Mean per hour of the day, over every observed day. */
  hourProfile: Array<number | null>;
  max: number;
  peak: WeeklyCell | null;
  /** Sum of every cell: the events the grid holds. */
  total: number;
};

/**
 * Averages a weekday × hour grid per occurrence of each weekday. A range
 * holding five Fridays and four Saturdays would otherwise make Friday look
 * busier by construction. The grid is `counts` (orders, admin actions) or
 * `sessions` (Umami), `number[7][24]` Sunday-first, with `days[d]` the number
 * of such weekdays in the range. Returns null for a missing or malformed grid.
 */
export function buildWeekly(value: unknown): WeeklyView | null {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const counts = record?.counts ?? record?.sessions;
  const days = record?.days;
  if (!Array.isArray(counts) || counts.length !== 7 || !Array.isArray(days) || days.length !== 7) {
    return null;
  }
  const grid = counts.map((row) =>
    Array.from({ length: 24 }, (_, hour) => (Array.isArray(row) ? finite(row[hour]) : null)),
  );
  if (grid.some((row) => row.some((count) => count === null))) return null;
  const observed = days.map((count) => finite(count) ?? 0);

  let max = 0;
  let total = 0;
  let peak: WeeklyCell | null = null;
  const view = PERSIAN_WEEK.map(({ dow, label }) => {
    const cells = grid[dow].map((sum, hour) => {
      const average = observed[dow] ? (sum as number) / observed[dow] : null;
      const cell = { dow, hour, total: sum as number, average };
      total += sum as number;
      if (average !== null && average > max) {
        max = average;
        peak = cell;
      }
      return cell;
    });
    const averages = cells.map((cell) => cell.average).filter((entry): entry is number => entry !== null);
    return {
      dow,
      label,
      observedDays: observed[dow],
      cells,
      hourlyMean: averages.length ? averages.reduce((a, b) => a + b, 0) / averages.length : null,
    };
  });
  const observedTotal = observed.reduce((a, b) => a + b, 0);
  const hourProfile = Array.from({ length: 24 }, (_, hour) =>
    observedTotal ? grid.reduce((sum, row) => sum + (row[hour] as number), 0) / observedTotal : null,
  );
  return { days: view, hourProfile, max, peak, total };
}

/** Step of `HEAT_RAMP` for a value: 0 only for a true zero, then six equal bands. */
export function heatStep(value: number | null, max: number): number | null {
  if (value === null) return null;
  if (value <= 0 || max <= 0) return 0;
  return Math.min(HEAT_RAMP.length - 1, 1 + Math.floor((value / max) * (HEAT_RAMP.length - 1)));
}

/**
 * Share of the grid's events that fall in the given hours (e.g. 22:00–07:00
 * for "outside working hours"). Null for an empty grid.
 */
export function hoursShare(view: WeeklyView, hours: ReadonlyArray<number>): number | null {
  if (!view.total) return null;
  const wanted = new Set(hours);
  const inside = view.days.reduce(
    (sum, day) => sum + day.cells.reduce((row, cell) => row + (wanted.has(cell.hour) ? cell.total : 0), 0),
    0,
  );
  return inside / view.total;
}
