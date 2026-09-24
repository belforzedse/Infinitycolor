import { finite } from "./format";
import { presentBehaviorValue, type BehaviorDimension } from "./presentation";

/**
 * Five muted identity colours for audience composition. Validated as a set
 * with the dataviz palette checks on the white card surface, *all pairs* (not
 * just neighbours), because which two groups touch in a bar depends on the
 * data: worst normal-vision ΔE 15.4, worst colour-blind ΔE 7.2. That is inside
 * the floor band, which is legal only with secondary encoding, so segments are
 * separated by gaps and every one is named in the legend and the table.
 */
export const AUDIENCE_PALETTE = ["#4f6cbd", "#53a4ce", "#d4ab52", "#559250", "#c46b8c"] as const;
/** A faint top highlight over a mark's colour; depth, not decoration. */
export const MARK_SHEEN = "linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 80%)";
/** Folded tail and unknown values are neutral, never a sixth hue. */
export const OTHER_COLOR = "#8e97a8";
export const UNKNOWN_COLOR = "#d3d8e1";

export type CompositionDimension = "device" | "os" | "browser";

/**
 * Colour follows the thing, not its rank: Apple is blue and Google green in
 * every bar, and a filter that removes a group never repaints the others.
 * Values without a slot here borrow a slot no present value owns.
 */
const ENTITY_SLOTS: Record<CompositionDimension, Record<string, number>> = {
  device: { mobile: 0, desktop: 1, laptop: 2, tablet: 3 },
  os: { ios: 0, windows10: 1, linux: 2, androidos: 3, android: 3, macos: 4 },
  browser: { ios: 0, samsung: 1, chromiumwebview: 2, chrome: 3, instagram: 4 },
};

/** At most this many named groups get a colour; the rest fold into «سایر». */
export const MAX_NAMED_SEGMENTS = AUDIENCE_PALETTE.length;

type Row = Record<string, unknown>;

export function entityKey(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[-_\s]/g, "");
}

function isUnknown(label: string) {
  const key = entityKey(label);
  return !key || key === "unknown" || key === "(unknown)" || key === "null";
}

function ratio(numerator: number | null, denominator: number | null) {
  return numerator !== null && denominator ? numerator / denominator : null;
}

export type CompositionSegment = {
  kind: "named" | "other" | "unknown";
  /** Raw Umami value for named segments; a stable id for the folded ones. */
  key: string;
  label: string;
  color: string;
  visitors: number;
  share: number;
  visits: number | null;
  bounceRate: number | null;
  pagesPerVisit: number | null;
  /** Seconds per visit. */
  avgDuration: number | null;
  /** Share in the previous period; null without comparison or without that group then. */
  previousShare: number | null;
  /** Change in share, in percentage points. */
  changePp: number | null;
  /** Folded «سایر» members, largest first. */
  members?: Array<{ label: string; share: number }>;
};

export type Composition = {
  dimension: CompositionDimension;
  total: number;
  segments: CompositionSegment[];
};

function totals(rows: Row[]) {
  return rows.reduce((sum, row) => sum + (finite(row.visitors) ?? 0), 0);
}

function aggregate(rows: Row[]) {
  const sum = (key: string) => {
    const values = rows.map((row) => finite(row[key]));
    return values.some((value) => value === null) ? null : values.reduce<number>((a, b) => a + (b ?? 0), 0);
  };
  const visits = sum("visits");
  return {
    visitors: totals(rows),
    visits,
    bounceRate: ratio(sum("bounces"), visits),
    pagesPerVisit: ratio(sum("pageviews"), visits),
    avgDuration: ratio(sum("totaltime"), visits),
  };
}

/**
 * Who uses what: each visitor has exactly one device, OS and browser, so the
 * groups partition the visitors and shares add up to 100%. Shares are of the
 * visitors Umami returned rows for (unknown included), so the bar is honest
 * about how much is unknown instead of stretching the known part to 100%.
 * Returns null when there is nothing to divide.
 */
export function buildComposition(
  dimension: CompositionDimension,
  value: unknown,
  previousValue?: unknown,
): Composition | null {
  const rows = (Array.isArray(value) ? value : []).filter(
    (row): row is Row => Boolean(row && typeof row === "object"),
  );
  const total = totals(rows);
  if (!total) return null;
  const labelOf = (row: Row) => String(row.label ?? row.name ?? "").trim();

  const previousRows = (Array.isArray(previousValue) ? previousValue : []).filter(
    (row): row is Row => Boolean(row && typeof row === "object"),
  );
  const previousTotal = Array.isArray(previousValue) ? totals(previousRows) : 0;
  const previousByKey = new Map<string, number>();
  for (const row of previousRows) {
    const key = isUnknown(labelOf(row)) ? "__unknown" : entityKey(labelOf(row));
    previousByKey.set(key, (previousByKey.get(key) ?? 0) + (finite(row.visitors) ?? 0));
  }
  const previousShareOf = (keys: string[]) => {
    if (!previousTotal) return null;
    return keys.reduce((sum, key) => sum + (previousByKey.get(key) ?? 0), 0) / previousTotal;
  };

  const known = rows
    .filter((row) => !isUnknown(labelOf(row)) && (finite(row.visitors) ?? 0) > 0)
    .sort((left, right) => (finite(right.visitors) ?? 0) - (finite(left.visitors) ?? 0));
  const unknownRows = rows.filter((row) => isUnknown(labelOf(row)));
  const named = known.slice(0, MAX_NAMED_SEGMENTS);
  const folded = known.slice(MAX_NAMED_SEGMENTS);

  // Fixed slots first, then free slots in palette order for the rest.
  const slots = ENTITY_SLOTS[dimension];
  const taken = new Set<number>();
  const slotFor = new Map<Row, number>();
  for (const row of named) {
    const slot = slots[entityKey(labelOf(row))];
    if (slot !== undefined && !taken.has(slot)) {
      taken.add(slot);
      slotFor.set(row, slot);
    }
  }
  for (const row of named) {
    if (slotFor.has(row)) continue;
    const slot = AUDIENCE_PALETTE.findIndex((_, index) => !taken.has(index));
    taken.add(slot);
    slotFor.set(row, slot);
  }

  const segment = (
    kind: CompositionSegment["kind"],
    key: string,
    label: string,
    color: string,
    group: Row[],
    previousKeys: string[],
  ): CompositionSegment => {
    const stats = aggregate(group);
    const share = stats.visitors / total;
    const previousShare = previousShareOf(previousKeys);
    return {
      kind,
      key,
      label,
      color,
      share,
      ...stats,
      previousShare,
      changePp: previousShare === null ? null : (share - previousShare) * 100,
    };
  };

  const segments = named.map((row) =>
    segment(
      "named",
      labelOf(row),
      presentBehaviorValue(labelOf(row), dimension as BehaviorDimension),
      AUDIENCE_PALETTE[slotFor.get(row) as number],
      [row],
      [entityKey(labelOf(row))],
    ),
  );
  if (folded.length) {
    const namedKeys = new Set(named.map((row) => entityKey(labelOf(row))));
    const other = segment(
      "other",
      "__other",
      "سایر",
      OTHER_COLOR,
      folded,
      [...previousByKey.keys()].filter((key) => key !== "__unknown" && !namedKeys.has(key)),
    );
    other.members = folded.map((row) => ({
      label: presentBehaviorValue(labelOf(row), dimension as BehaviorDimension),
      share: (finite(row.visitors) ?? 0) / total,
    }));
    segments.push(other);
  }
  if (totals(unknownRows) > 0) {
    segments.push(segment("unknown", "__unknown", "نامشخص", UNKNOWN_COLOR, unknownRows, ["__unknown"]));
  }
  return { dimension, total, segments };
}

/** Saturday-first Persian week; Umami's grid is Sunday-first (Postgres `dow`). */
export const PERSIAN_WEEK: ReadonlyArray<{ dow: number; label: string }> = [
  { dow: 6, label: "شنبه" },
  { dow: 0, label: "یکشنبه" },
  { dow: 1, label: "دوشنبه" },
  { dow: 2, label: "سه‌شنبه" },
  { dow: 3, label: "چهارشنبه" },
  { dow: 4, label: "پنجشنبه" },
  { dow: 5, label: "جمعه" },
];

/** Seven steps of one navy hue, light (none) to dark (most); lightness-monotone. */
export const HEAT_RAMP = [
  "#eff3fa",
  "#cdd4e5",
  "#acb7d0",
  "#8c99bb",
  "#6d7da6",
  "#506191",
  "#34467c",
] as const;

export type WeeklyCell = {
  dow: number;
  hour: number;
  /** Sessions active in this hour, summed over the range. */
  total: number;
  /** Per such weekday in the range; null when the range held none of it. */
  average: number | null;
};

export type WeeklyView = {
  days: Array<{ dow: number; label: string; observedDays: number; cells: WeeklyCell[]; hourlyMean: number | null }>;
  /** Mean active sessions per hour of the day, over every observed day. */
  hourProfile: Array<number | null>;
  max: number;
  peak: WeeklyCell | null;
};

/**
 * Averages the weekday × hour grid per occurrence of each weekday. A range
 * holding five Fridays and four Saturdays would otherwise make Friday look
 * busier by construction. Returns null for a missing or malformed section.
 */
export function buildWeekly(value: unknown): WeeklyView | null {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const sessions = record?.sessions;
  const days = record?.days;
  if (!Array.isArray(sessions) || sessions.length !== 7 || !Array.isArray(days) || days.length !== 7) {
    return null;
  }
  const grid = sessions.map((row) =>
    Array.from({ length: 24 }, (_, hour) => (Array.isArray(row) ? finite(row[hour]) : null)),
  );
  if (grid.some((row) => row.some((count) => count === null))) return null;
  const observed = days.map((count) => finite(count) ?? 0);

  let max = 0;
  let peak: WeeklyCell | null = null;
  const view = PERSIAN_WEEK.map(({ dow, label }) => {
    const cells = grid[dow].map((total, hour) => {
      const average = observed[dow] ? (total as number) / observed[dow] : null;
      const cell = { dow, hour, total: total as number, average };
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
  return { days: view, hourProfile, max, peak };
}

/** Step of `HEAT_RAMP` for a value: 0 only for a true zero, then six equal bands. */
export function heatStep(value: number | null, max: number): number | null {
  if (value === null) return null;
  if (value <= 0 || max <= 0) return 0;
  return Math.min(HEAT_RAMP.length - 1, 1 + Math.floor((value / max) * (HEAT_RAMP.length - 1)));
}
