"use client";

import { useMemo, type ReactNode } from "react";
import type { DotProps } from "recharts";
import { ChartSkeleton } from "@/components/admin";
import { cn } from "@/utils/tailwind";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "./charts";
import {
  AREA_FADE,
  AXIS_COLOR,
  AXIS_TICK,
  COMPARISON_COLOR,
  CURSOR_COLOR,
  GRID_COLOR,
  SERIES_COLOR,
} from "./chartTheme";
import { AnalyticsTable } from "./AnalyticsTable";
import { ChartTooltipCard, TOOLTIP_SURFACE, useTooltipEscape } from "./ChartTooltip";
import { DeltaBadge } from "./DeltaBadge";
import { compactNumber, relativeChange } from "./format";
import { DURATION, SWAP, usePrefersReducedMotion } from "./motion";
import { Notice } from "./ui";

export type SeriesRow = {
  /** Stable bucket key. */
  key: string;
  /** Short axis label. */
  label: string;
  /** The bucket in words for the tooltip and table: a date or a date span. */
  title: string;
  current: number | null;
  previous?: number | null;
  /** The comparison bucket in words; absent when there is no comparison. */
  previousTitle?: string | null;
  /** The bucket is still open (it contains today): drawn dashed. */
  incomplete?: boolean;
  /** A caveat on the whole bucket, e.g. «بخشی از بازه». */
  flag?: string | null;
  /** Why `current` is not known; the point is a gap, never a zero. */
  unknownReason?: string | null;
  /** A caveat on a known value, e.g. «بدون کسر مرجوعی». */
  note?: string | null;
};

type ChartRow = SeriesRow & { settled: number | null; open: number | null };

/**
 * Lines carry no dot per point, but a value with a gap on both sides would
 * draw nothing at all; this marks only those.
 */
export function isolatedDot(dataKey: string, color: string = SERIES_COLOR) {
  function IsolatedDot(props: DotProps & { index?: number }) {
    const { cx, cy, index = 0 } = props;
    // Recharts passes the whole line's points, though its type calls them a string.
    const points =
      (props as unknown as { points?: ReadonlyArray<{ payload?: Record<string, unknown> }> }).points ?? [];
    const present = (entry?: { payload?: Record<string, unknown> }) =>
      entry?.payload?.[dataKey] !== null && entry?.payload?.[dataKey] !== undefined;
    const isolated =
      present(points[index]) && !present(points[index - 1]) && !present(points[index + 1]);
    if (!isolated || cx === undefined || cy === undefined) return <g key={`dot-${index}`} />;
    return <circle key={`dot-${index}`} cx={cx} cy={cy} r={3} fill={color} stroke="#fff" strokeWidth={1.5} />;
  }
  return IsolatedDot;
}

function toChartRows(rows: SeriesRow[]): ChartRow[] {
  const firstOpen = rows.findIndex((row) => row.incomplete);
  return rows.map((row, index) => ({
    ...row,
    settled: row.incomplete ? null : row.current,
    // The dashed tail starts at the last settled point so the line stays joined.
    open: firstOpen >= 0 && (index >= firstOpen || index === firstOpen - 1) ? row.current : null,
  }));
}

function SeriesTooltip({
  active,
  payload,
  seriesLabel,
  valueText,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
  seriesLabel: string;
  valueText: (value: number | null) => string;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const change = row.previousTitle ? relativeChange(row.current, row.previous) : null;
  return (
    <div className={TOOLTIP_SURFACE}>
      <ChartTooltipCard
        title={seriesLabel}
        rows={[
          {
            key: "current",
            label: (
              <>
                {row.title}
                {row.incomplete ? " (ناتمام)" : row.flag ? ` (${row.flag})` : ""}
              </>
            ),
            value: valueText(row.current),
            color: SERIES_COLOR,
            unknown: row.current === null ? (row.unknownReason ?? "داده‌ای ثبت نشده") : undefined,
          },
          ...(row.previousTitle
            ? [
                {
                  key: "previous",
                  label: row.previousTitle,
                  value: valueText(row.previous ?? null),
                  color: COMPARISON_COLOR,
                  muted: true,
                },
              ]
            : []),
        ]}
        footer={
          <>
            {row.previousTitle && row.current !== null ? <DeltaBadge change={change} /> : null}
            {row.note ? <p className="mt-1 text-amber-800">{row.note}</p> : null}
          </>
        }
      />
    </div>
  );
}

/**
 * The reports' line chart: this period as a navy line over a fading area,
 * the previous period as a slate line, an open bucket dashed, unknown values
 * as gaps. No dot on every point; the hovered one is marked. Time runs left to
 * right like every time axis in the reports. The line draws itself in and
 * morphs when the data changes; while a new range loads the old chart dims
 * instead of disappearing. `view="table"` shows the same rows as a table.
 */
export default function TimeSeriesChart({
  rows,
  seriesLabel,
  valueText,
  axisText = (value) => compactNumber(value),
  loading = false,
  error,
  emptyText = "در این بازه داده‌ای ثبت نشده است.",
  view = "chart",
  tableId,
  heightClass = "h-[300px]",
  yAxisWidth = 64,
  gradientId,
}: {
  rows: SeriesRow[] | null;
  /** What the line is, e.g. «نقدینگی». */
  seriesLabel: string;
  valueText: (value: number | null) => string;
  axisText?: (value: number) => string;
  loading?: boolean;
  error?: ReactNode;
  emptyText?: string;
  view?: "chart" | "table";
  tableId?: string;
  heightClass?: string;
  yAxisWidth?: number;
  /** Unique per page: the area fade is an SVG gradient referenced by id. */
  gradientId: string;
}) {
  const escape = useTooltipEscape();
  const reduced = usePrefersReducedMotion();
  const chartRows = useMemo(() => (rows ? toChartRows(rows) : []), [rows]);
  const hasPrevious = Boolean(rows?.some((row) => row.previousTitle));
  const hasValues = Boolean(rows?.some((row) => row.current !== null));
  const animate = !reduced;

  if (loading && !rows) return <ChartSkeleton className={heightClass} />;
  if (error) return <Notice tone="warning">{error}</Notice>;
  if (!rows || !hasValues) {
    return (
      <p className="rounded-control border border-dashed border-slate-200 px-4 py-10 text-center text-xs text-slate-500">
        {emptyText}
      </p>
    );
  }

  if (view === "table") {
    return (
      <div id={tableId} className={SWAP}>
        <AnalyticsTable
          caption={`روند ${seriesLabel}`}
          rows={rows}
          rowKey={(row) => row.key}
          maxRows={120}
          dense
          columns={[
            {
              key: "title",
              label: "دوره",
              render: (row) => (
                <span>
                  {row.title}
                  {row.incomplete ? <span className="text-slate-500"> (ناتمام)</span> : null}
                  {!row.incomplete && row.flag ? <span className="text-slate-500"> ({row.flag})</span> : null}
                </span>
              ),
            },
            {
              key: "current",
              label: seriesLabel,
              numeric: true,
              render: (row) =>
                row.current === null ? (
                  <span className="text-amber-800">{row.unknownReason ?? "نامعلوم"}</span>
                ) : (
                  <span>
                    {valueText(row.current)}
                    {row.note ? <span className="block text-[10px] text-amber-800">{row.note}</span> : null}
                  </span>
                ),
            },
            ...(hasPrevious
              ? [
                  {
                    key: "previousTitle",
                    label: "دوره متناظر قبل",
                    render: (row: SeriesRow) => row.previousTitle ?? "—",
                  },
                  {
                    key: "previous",
                    label: "دوره قبل",
                    numeric: true,
                    render: (row: SeriesRow) => valueText(row.previous ?? null),
                  },
                  {
                    key: "change",
                    label: "تغییر",
                    numeric: true,
                    render: (row: SeriesRow) => <DeltaBadge change={relativeChange(row.current, row.previous)} />,
                  },
                ]
              : []),
          ]}
        />
      </div>
    );
  }

  return (
    <div
      role="figure"
      aria-label={`نمودار روند ${seriesLabel}؛ با کلیدهای جهت‌نما بین نقطه‌ها بروید، مقدارهای دقیق در «نمایش جدول»`}
      className={cn("transition-opacity duration-300", loading && "opacity-60", SWAP)}
      {...escape.handlers}
    >
      <div className={heightClass} dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartRows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
            <defs>
              {/* The area fades out towards the axis instead of a flat block. */}
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SERIES_COLOR} stopOpacity={AREA_FADE.from} />
                <stop offset="100%" stopColor={SERIES_COLOR} stopOpacity={AREA_FADE.to} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke={GRID_COLOR} />
            <XAxis
              dataKey="label"
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: AXIS_COLOR }}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={yAxisWidth}
              allowDecimals={false}
              tickFormatter={(value: number) => axisText(value)}
            />
            <Tooltip
              active={escape.active}
              cursor={{ stroke: CURSOR_COLOR, strokeWidth: 1 }}
              animationDuration={DURATION.micro}
              content={<SeriesTooltip seriesLabel={seriesLabel} valueText={valueText} />}
            />
            {hasPrevious ? (
              <Line
                type="monotone"
                dataKey="previous"
                stroke={COMPARISON_COLOR}
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive={animate}
                animationDuration={DURATION.chart}
                animationEasing="ease-out"
                name="دوره قبل"
              />
            ) : null}
            <Area
              type="monotone"
              dataKey="settled"
              stroke={SERIES_COLOR}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              fillOpacity={1}
              dot={isolatedDot("settled")}
              activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }}
              isAnimationActive={animate}
              animationBegin={hasPrevious ? 120 : 0}
              animationDuration={DURATION.chart}
              animationEasing="ease-out"
              name="این دوره"
            />
            <Line
              type="monotone"
              dataKey="open"
              stroke={SERIES_COLOR}
              strokeWidth={2}
              strokeDasharray="4 4"
              dot={false}
              activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }}
              isAnimationActive={false}
              legendType="none"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** The legend line under a series chart: swatches that match the lines. */
export function SeriesLegend({
  current,
  previous,
  incomplete,
  lead,
  children,
}: {
  current: ReactNode;
  previous?: ReactNode;
  incomplete?: boolean;
  /** Shown first, e.g. where the numbers come from. */
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
      {lead}
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-0.5 w-4 rounded" style={{ background: SERIES_COLOR }} />
        {current}
      </span>
      {previous ? (
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 rounded" style={{ background: COMPARISON_COLOR }} />
          {previous}
        </span>
      ) : null}
      {incomplete ? (
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: SERIES_COLOR }} />
          امروز هنوز تمام نشده است
        </span>
      ) : null}
      {children}
    </div>
  );
}
