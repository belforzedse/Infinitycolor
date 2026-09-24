/**
 * Single dynamic-import point for recharts primitives used across the reports
 * workspace. Every report page previously repeated this ~8-line `dynamic(() =>
 * import("recharts")...)` preamble (liquidity, gateway-liquidity, traffic,
 * TrendsTab, ProductDrawer) — this is the one place it lives now.
 *
 * `{ ssr: false }` on every export: recharts measures the DOM, so it cannot render
 * server-side.
 */
import dynamic from "next/dynamic";
// `Cell` is a plain config descriptor (no DOM measurement), and recharts identifies
// it inside `<Bar>`/`<Pie>` by `child.type.displayName === "Cell"` (see
// recharts/lib/util/ReactUtils.js findAllByType) — a next/dynamic wrapper's type
// would never match that, so per-segment coloring would silently stop working.
// Imported statically for this reason; every other export here needs `ssr: false`
// because it measures the DOM, which Cell does not.
export { Cell } from "recharts";

export const ResponsiveContainer = dynamic(
  () => import("recharts").then((m) => m.ResponsiveContainer),
  { ssr: false },
);
export const LineChart = dynamic(() => import("recharts").then((m) => m.LineChart), { ssr: false });
export const Line = dynamic(() => import("recharts").then((m) => m.Line), { ssr: false });
export const BarChart = dynamic(() => import("recharts").then((m) => m.BarChart), { ssr: false });
export const Bar = dynamic(() => import("recharts").then((m) => m.Bar), { ssr: false });
export const AreaChart = dynamic(() => import("recharts").then((m) => m.AreaChart), { ssr: false });
export const ComposedChart = dynamic(() => import("recharts").then((m) => m.ComposedChart), {
  ssr: false,
});
export const Area = dynamic(() => import("recharts").then((m) => m.Area), { ssr: false });
export const PieChart = dynamic(() => import("recharts").then((m) => m.PieChart), { ssr: false });
export const Pie = dynamic(() => import("recharts").then((m) => m.Pie), { ssr: false });
export const Sankey = dynamic(() => import("recharts").then((m) => m.Sankey), { ssr: false });
export const XAxis = dynamic(() => import("recharts").then((m) => m.XAxis), { ssr: false });
export const YAxis = dynamic(() => import("recharts").then((m) => m.YAxis), { ssr: false });
export const CartesianGrid = dynamic(() => import("recharts").then((m) => m.CartesianGrid), {
  ssr: false,
});
export const Tooltip = dynamic(() => import("recharts").then((m) => m.Tooltip), { ssr: false });
// `as any`: recharts' Legend.defaultProps.layout type conflicts with React 19's
// dynamic-import typings (same workaround already used in reports/traffic/page.tsx).
export const Legend = dynamic(() => import("recharts").then((m) => m.Legend as any), {
  ssr: false,
});

/** Consistent categorical palette for pie/bar charts across every report page. */
export const REPORT_CHART_COLORS = [
  "#6366f1",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
  "#a855f7",
  "#84cc16",
  "#ec4899",
];
