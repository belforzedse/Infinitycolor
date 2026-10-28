/**
 * The weekday × hour grid the admin's «when» heatmaps draw: `counts[d][h]`
 * sums the events in hour h over every weekday d of the window (row 0 is
 * Sunday, as Postgres `dow`), and `days[d]` counts those weekdays in the
 * window, so the admin averages per day instead of favouring a weekday the
 * window happened to hold five times. Same shape as the Umami audience grid.
 */
export type WeekdayGrid = {
  timezone: string;
  firstDay: "sunday";
  counts: number[][];
  days: number[];
};

const DAY_MS = 86_400_000;

/** How many of each weekday (0 = Sunday) fall in `startYmd..endYmd`, inclusive. */
export function weekdayCounts(startYmd: string, endYmd: string): number[] {
  const days = [0, 0, 0, 0, 0, 0, 0];
  const first = Date.parse(`${startYmd}T12:00:00Z`);
  const last = Date.parse(`${endYmd}T12:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return days;
  for (let t = first; t <= last; t += DAY_MS) days[new Date(t).getUTCDay()] += 1;
  return days;
}

/** Folds `{dow, hour, count}` rows into a full 7×24 grid; unmatched cells are true zeros. */
export function weekdayGrid(
  rows: ReadonlyArray<{ dow: unknown; hour: unknown; count: unknown }>,
  startYmd: string,
  endYmd: string,
  timezone: string,
): WeekdayGrid {
  const counts = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const row of rows) {
    const dow = Number(row.dow);
    const hour = Number(row.hour);
    const count = Number(row.count);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    if (!Number.isFinite(count)) continue;
    counts[dow][hour] += count;
  }
  return { timezone, firstDay: "sunday", counts, days: weekdayCounts(startYmd, endYmd) };
}
