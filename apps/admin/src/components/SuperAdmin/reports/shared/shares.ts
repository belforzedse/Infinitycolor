import { CATEGORICAL_PALETTE, OTHER_COLOR, UNKNOWN_COLOR } from "./chartTheme";

/** At most this many named groups get a colour; the rest fold into «سایر». */
export const MAX_NAMED_SEGMENTS = CATEGORICAL_PALETTE.length;

export type ShareSegment = {
  kind: "named" | "other" | "unknown";
  /** The item's own key for named segments; a stable id for folded ones. */
  key: string;
  label: string;
  color: string;
  value: number;
  /** 0–1 of the positive total. */
  share: number;
  /** Folded «سایر» members, largest first. */
  members?: Array<{ key: string; label: string; share: number }>;
};

/**
 * Colour follows the thing, not its rank: a key with a fixed slot always gets
 * that colour, and a filter that removes a group never repaints the others.
 * Keys without a slot borrow, in palette order, a slot no present key owns.
 */
export function assignColors(keys: string[], fixedSlots: Record<string, number> = {}): Map<string, string> {
  const taken = new Set<number>();
  const slotFor = new Map<string, number>();
  for (const key of keys) {
    const slot = fixedSlots[key];
    if (slot !== undefined && !taken.has(slot)) {
      taken.add(slot);
      slotFor.set(key, slot);
    }
  }
  for (const key of keys) {
    if (slotFor.has(key)) continue;
    const slot = CATEGORICAL_PALETTE.findIndex((_, index) => !taken.has(index));
    taken.add(slot);
    slotFor.set(key, slot);
  }
  return new Map([...slotFor].map(([key, slot]) => [key, CATEGORICAL_PALETTE[slot] ?? OTHER_COLOR]));
}

export type ShareInput = { key: string; label: string; value: number | null; unknown?: boolean };

export type Shares = {
  total: number;
  segments: ShareSegment[];
  /** Items left out because a part-to-whole bar cannot hold them (zero or negative). */
  excluded: number;
};

/**
 * Part-to-whole for a list that partitions a total (orders by status, cash by
 * gateway): sorted largest first, the top groups named, the tail folded into
 * «سایر», unknown kept apart as «نامشخص». Items at or below zero cannot be a
 * share of anything and are counted in `excluded` for the caller to mention.
 * Returns null when nothing positive remains.
 */
export function buildShares(
  items: ReadonlyArray<ShareInput>,
  { maxNamed = MAX_NAMED_SEGMENTS, fixedSlots }: { maxNamed?: number; fixedSlots?: Record<string, number> } = {},
): Shares | null {
  const positive = items.filter((item) => (item.value ?? 0) > 0);
  const total = positive.reduce((sum, item) => sum + (item.value as number), 0);
  if (!total) return null;
  const known = positive
    .filter((item) => !item.unknown)
    .sort((left, right) => (right.value as number) - (left.value as number));
  const unknown = positive.filter((item) => item.unknown);
  const named = known.slice(0, maxNamed);
  const folded = known.slice(maxNamed);
  const colors = assignColors(
    named.map((item) => item.key),
    fixedSlots,
  );
  const segments: ShareSegment[] = named.map((item) => ({
    kind: "named",
    key: item.key,
    label: item.label,
    color: colors.get(item.key) as string,
    value: item.value as number,
    share: (item.value as number) / total,
  }));
  if (folded.length) {
    const value = folded.reduce((sum, item) => sum + (item.value as number), 0);
    segments.push({
      kind: "other",
      key: "__other",
      label: "سایر",
      color: OTHER_COLOR,
      value,
      share: value / total,
      members: folded.map((item) => ({ key: item.key, label: item.label, share: (item.value as number) / total })),
    });
  }
  if (unknown.length) {
    const value = unknown.reduce((sum, item) => sum + (item.value as number), 0);
    segments.push({ kind: "unknown", key: "__unknown", label: "نامشخص", color: UNKNOWN_COLOR, value, share: value / total });
  }
  return { total, segments, excluded: items.length - positive.length };
}

/** Share of a row within a positive total, or null when it cannot be one. */
export function shareOf(value: number | null | undefined, total: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0 || total <= 0) return null;
  return value / total;
}
