import { finite } from "@/components/SuperAdmin/reports/shared/format";
import { OTHER_COLOR, UNKNOWN_COLOR } from "@/components/SuperAdmin/reports/shared/chartTheme";
import {
  MAX_NAMED_SEGMENTS,
  assignColors,
  type ShareSegment,
} from "@/components/SuperAdmin/reports/shared/shares";
import { presentBehaviorValue, type BehaviorDimension } from "./presentation";

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

/** A share segment (keyed by the raw Umami value) with the visitors' behaviour. */
export type CompositionSegment = ShareSegment & {
  visitors: number;
  visits: number | null;
  bounceRate: number | null;
  pagesPerVisit: number | null;
  /** Seconds per visit. */
  avgDuration: number | null;
  /** Share in the previous period; null without comparison or without that group then. */
  previousShare: number | null;
  /** Change in share, in percentage points. */
  changePp: number | null;
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
  const colors = assignColors(
    named.map((row) => entityKey(labelOf(row))),
    ENTITY_SLOTS[dimension],
  );

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
      value: stats.visitors,
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
      colors.get(entityKey(labelOf(row))) as string,
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
      key: labelOf(row),
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
