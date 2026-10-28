/**
 * The one chart look for every report page. Colours carry meaning or they are
 * grey: navy is "this period", slate is "the period before", the categorical
 * set names groups, the sequential ramp encodes magnitude, and emerald/rose
 * are reserved for good/bad change.
 *
 * Kept apart from `charts.ts` (which re-exports it) so modules and tests that
 * mock the recharts wrappers still get real colours.
 */

/** This period. The brand navy; validated against the white card surface. */
export const SERIES_COLOR = "#3d4c6e";
/** The comparison period: de-emphasised, never competing with the series. */
export const COMPARISON_COLOR = "#7c8798";

/** Gridlines sit lighter than the axis line, which sits lighter than tick text. */
export const GRID_COLOR = "#eef1f5";
export const AXIS_COLOR = "#e2e8f0";
export const TICK_COLOR = "#475569";
export const CURSOR_COLOR = "#94a3b8";
export const AXIS_TICK = { fontSize: 11, fill: TICK_COLOR } as const;

/** Top and bottom opacity of the fade under a line. */
export const AREA_FADE = { from: 0.16, to: 0 } as const;

/**
 * Five muted identity colours. Validated as a set with the dataviz palette
 * checks on the white card surface, *all pairs* (not just neighbours), since
 * which two groups touch depends on the data: worst normal-vision ΔE 15.4,
 * worst colour-blind ΔE 7.2. That is inside the floor band, which is legal
 * only with secondary encoding, so marks are separated by gaps and every
 * group is also named in a legend and a table.
 */
export const CATEGORICAL_PALETTE = ["#4f6cbd", "#53a4ce", "#d4ab52", "#559250", "#c46b8c"] as const;
/** A folded tail («سایر») and unknown values are neutral, never a sixth hue. */
export const OTHER_COLOR = "#8e97a8";
export const UNKNOWN_COLOR = "#d3d8e1";

/** A faint top highlight over a filled mark: depth, not decoration. */
export const MARK_SHEEN = "linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 80%)";

/** Seven steps of one navy hue, light (none) to dark (most); lightness-monotone. */
export const SEQUENTIAL_RAMP = [
  "#eff3fa",
  "#cdd4e5",
  "#acb7d0",
  "#8c99bb",
  "#6d7da6",
  "#506191",
  "#34467c",
] as const;

/** Text colour for a change that is good or bad; always paired with an arrow and words. */
export const GOOD_TEXT = "text-emerald-700";
export const BAD_TEXT = "text-rose-700";
export const NEUTRAL_TEXT = "text-slate-600";
