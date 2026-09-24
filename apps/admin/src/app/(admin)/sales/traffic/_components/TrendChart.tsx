"use client";

import { useId, useMemo, useState } from "react";
import { AdminCard, ChartSkeleton } from "@/components/admin";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "@/components/SuperAdmin/reports/shared/charts";
import type {
  CommerceSeriesPoint,
  TrendPoint,
} from "@/types/super-admin/reports/behavior";
import {
  bucketText,
  compactNumber,
  numberText,
  rangeText,
  relativeChange,
  tomanText,
} from "../format";
import { AnalyticsTable } from "./AnalyticsTable";
import {
  COMPARISON_COLOR,
  Delta,
  Notice,
  SERIES_COLOR,
  SectionHeader,
  Segmented,
  SourceLabel,
  TableToggle,
} from "./ui";

export type TrendMetric = "visitors" | "pageviews" | "paidOrders" | "revenue";
type Unit = "hour" | "day" | "month";

export const TREND_METRICS: ReadonlyArray<{
  id: TrendMetric;
  label: string;
  source: "umami" | "commerce";
  description: string;
}> = [
  {
    id: "visitors",
    label: "بازدیدکننده",
    source: "umami",
    description: "بازدیدکنندگان یکتای هر روز؛ جمع روزها از کل بازه بیشتر است چون یک نفر در چند روز شمرده می‌شود.",
  },
  {
    id: "pageviews",
    label: "نمایش صفحه",
    source: "umami",
    description: "هر بار باز شدن یا تغییر صفحه.",
  },
  {
    id: "paidOrders",
    label: "سفارش پرداخت‌شده",
    source: "commerce",
    description: "سفارش‌های فروشگاه جدید به تاریخ ثبت سفارش، از پایگاه داده فروشگاه.",
  },
  {
    id: "revenue",
    label: "درآمد خالص",
    source: "commerce",
    description: "پرداخت‌های موفق این سفارش‌ها منهای مرجوعی، به تومان.",
  },
];

export type TrendSources = {
  trend?: { unit?: Unit; points?: TrendPoint[] } | null;
  previousTrend?: { unit?: Unit; points?: TrendPoint[] } | null;
  commerce?: { unit?: Unit; points?: CommerceSeriesPoint[] } | null;
  previousCommerce?: { unit?: Unit; points?: CommerceSeriesPoint[] } | null;
};

export type TrendRow = {
  index: number;
  t: string;
  previousT: string | null;
  current: number | null;
  previous: number | null;
  /** The bucket is still open (today): its value will keep growing. */
  incomplete: boolean;
};

function pick(point: TrendPoint | CommerceSeriesPoint | undefined, metric: TrendMetric) {
  if (!point) return null;
  const value =
    metric === "visitors"
      ? (point as TrendPoint).visitors
      : metric === "pageviews"
        ? (point as TrendPoint).pageviews
        : metric === "paidOrders"
          ? (point as CommerceSeriesPoint).paidOrders
          : (point as CommerceSeriesPoint).revenueToman;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Rows for one metric. The previous period is aligned by position (day 1 with
 * day 1), which is what "compared with the previous period" means for equal
 * lengths; each row keeps both dates for the tooltip and table.
 */
export function buildTrendRows(
  metric: TrendMetric,
  sources: TrendSources,
  today: string,
): { unit: Unit; rows: TrendRow[] } | null {
  const commerce = metric === "paidOrders" || metric === "revenue";
  const series = commerce ? sources.commerce : sources.trend;
  const previousSeries = commerce ? sources.previousCommerce : sources.previousTrend;
  const points = series?.points;
  if (!Array.isArray(points) || !points.length) return null;
  const unit: Unit = series?.unit ?? "day";
  const previous = Array.isArray(previousSeries?.points) ? previousSeries.points : [];
  const cutoff = unit === "month" ? today.slice(0, 7) : today;
  return {
    unit,
    rows: points.map((point, index) => ({
      index,
      t: point.t,
      previousT: previous[index]?.t ?? null,
      current: pick(point, metric),
      previous: pick(previous[index], metric),
      incomplete: (unit === "month" ? point.t.slice(0, 7) : point.t.slice(0, 10)) >= cutoff,
    })),
  };
}

function valueText(metric: TrendMetric, value: number | null) {
  return metric === "revenue" ? tomanText(value) : numberText(value);
}

type ChartRow = TrendRow & {
  label: string;
  settled: number | null;
  open: number | null;
};

function toChartRows(rows: TrendRow[], unit: Unit): ChartRow[] {
  const firstOpen = rows.findIndex((row) => row.incomplete);
  return rows.map((row, index) => ({
    ...row,
    label: bucketText(row.t, unit),
    settled: row.incomplete ? null : row.current,
    // The dashed tail starts at the last settled point so the line stays joined.
    open:
      firstOpen >= 0 && (index >= firstOpen || index === firstOpen - 1) ? row.current : null,
  }));
}

function TrendTooltip({
  active,
  payload,
  metric,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
  metric: TrendMetric;
  unit: Unit;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const change = relativeChange(row.current, row.previous);
  return (
    <div dir="rtl" className="min-w-48 rounded-control border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-1.5 text-slate-600">
          <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: SERIES_COLOR }} />
          {bucketText(row.t, unit)}
          {row.incomplete ? " (ناتمام)" : ""}
        </span>
        <strong className="tabular-nums text-slate-900">{valueText(metric, row.current)}</strong>
      </p>
      {row.previousT ? (
        <p className="mt-1 flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-slate-600">
            <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: COMPARISON_COLOR }} />
            {bucketText(row.previousT, unit)}
          </span>
          <span className="tabular-nums text-slate-800">{valueText(metric, row.previous)}</span>
        </p>
      ) : null}
      {row.previousT ? <Delta className="mt-1.5" change={change} /> : null}
    </div>
  );
}

export default function TrendChart({
  sources,
  metric,
  onMetric,
  loading,
  range,
  previousRange,
  today,
  unavailableReason,
}: {
  sources: TrendSources;
  metric: TrendMetric;
  onMetric: (metric: TrendMetric) => void;
  loading: boolean;
  range: { start: string; end: string };
  previousRange?: { start: string; end: string } | null;
  today: string;
  /** Set when the series is missing because its source failed or is too old. */
  unavailableReason?: string | null;
}) {
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const definition = TREND_METRICS.find((item) => item.id === metric) ?? TREND_METRICS[0];
  const built = useMemo(() => buildTrendRows(metric, sources, today), [metric, sources, today]);
  const hasPrevious = Boolean(built?.rows.some((row) => row.previousT));
  const hasValues = Boolean(built?.rows.some((row) => row.current !== null));
  const chartRows = useMemo(
    () => (built ? toChartRows(built.rows, built.unit) : []),
    [built],
  );

  return (
    <AdminCard>
      <SectionHeader
        title="روند"
        description={definition.description}
        actions={
          <>
            <Segmented
              label="شاخص نمودار روند"
              value={metric}
              options={TREND_METRICS.map(({ id, label }) => ({ id, label }))}
              onChange={onMetric}
            />
            {built && hasValues ? (
              <TableToggle
                showing={showTable}
                onToggle={() => setShowTable((value) => !value)}
                controls={tableId}
              />
            ) : null}
          </>
        }
      />
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
        <SourceLabel source={definition.source} />
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 rounded" style={{ background: SERIES_COLOR }} />
          این دوره: {rangeText(range.start, range.end)}
        </span>
        {hasPrevious && previousRange ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="h-0.5 w-4 rounded" style={{ background: COMPARISON_COLOR }} />
            دوره قبل: {rangeText(previousRange.start, previousRange.end)}
          </span>
        ) : null}
        {built?.rows.some((row) => row.incomplete) ? (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-0 w-4 border-t-2 border-dashed"
              style={{ borderColor: SERIES_COLOR }}
            />
            امروز هنوز تمام نشده است
          </span>
        ) : null}
      </div>

      <div className="mt-4" aria-busy={loading}>
        {loading && !built ? (
          <ChartSkeleton className="h-[300px]" />
        ) : !built ? (
          <Notice tone="warning">
            {unavailableReason ?? "داده روند برای این شاخص در دسترس نیست."}
          </Notice>
        ) : !hasValues ? (
          <p className="rounded-control border border-dashed border-slate-200 px-4 py-10 text-center text-xs text-slate-500">
            در این بازه داده‌ای ثبت نشده است.
          </p>
        ) : showTable ? (
          <div id={tableId}>
            <AnalyticsTable
              caption={`روند ${definition.label}`}
              rows={built.rows}
              rowKey={(row) => row.t}
              maxRows={120}
              dense
              columns={[
                {
                  key: "t",
                  label: "تاریخ",
                  render: (row) => (
                    <span>
                      {bucketText(row.t, built.unit)}
                      {row.incomplete ? <span className="text-slate-500"> (ناتمام)</span> : null}
                    </span>
                  ),
                },
                {
                  key: "current",
                  label: definition.label,
                  numeric: true,
                  render: (row) => valueText(metric, row.current),
                },
                ...(hasPrevious
                  ? [
                      {
                        key: "previousT",
                        label: "روز متناظر دوره قبل",
                        render: (row: TrendRow) =>
                          row.previousT ? bucketText(row.previousT, built.unit) : "—",
                      },
                      {
                        key: "previous",
                        label: "دوره قبل",
                        numeric: true,
                        render: (row: TrendRow) => valueText(metric, row.previous),
                      },
                      {
                        key: "change",
                        label: "تغییر",
                        numeric: true,
                        render: (row: TrendRow) => (
                          <Delta change={relativeChange(row.current, row.previous)} />
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        ) : (
          <div
            className={loading ? "opacity-60 transition-opacity" : undefined}
            role="img"
            aria-label={`نمودار روند ${definition.label}؛ مقدارهای دقیق در «نمایش جدول»`}
          >
            <div className="h-[300px]" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartRows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                  <defs>
                    {/* The area fades out towards the axis instead of a flat block. */}
                    <linearGradient id="traffic-trend-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={SERIES_COLOR} stopOpacity={0.16} />
                      <stop offset="100%" stopColor={SERIES_COLOR} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="#eef1f5" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: "#475569" }}
                    tickLine={false}
                    axisLine={{ stroke: "#e2e8f0" }}
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#475569" }}
                    tickLine={false}
                    axisLine={false}
                    width={64}
                    allowDecimals={false}
                    tickFormatter={(value: number) => compactNumber(value)}
                  />
                  <Tooltip
                    cursor={{ stroke: "#94a3b8", strokeWidth: 1 }}
                    content={<TrendTooltip metric={metric} unit={built.unit} />}
                  />
                  {hasPrevious ? (
                    <Line
                      type="monotone"
                      dataKey="previous"
                      stroke={COMPARISON_COLOR}
                      strokeWidth={1.5}
                      dot={false}
                      activeDot={{ r: 3 }}
                      isAnimationActive={false}
                      name="دوره قبل"
                    />
                  ) : null}
                  <Area
                    type="monotone"
                    dataKey="settled"
                    stroke={SERIES_COLOR}
                    strokeWidth={2}
                    fill="url(#traffic-trend-fill)"
                    fillOpacity={1}
                    dot={false}
                    activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }}
                    isAnimationActive={false}
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
        )}
      </div>
    </AdminCard>
  );
}
