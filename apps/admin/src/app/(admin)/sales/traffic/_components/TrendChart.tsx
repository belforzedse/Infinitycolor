"use client";

import { useId, useMemo, useState } from "react";
import { AdminCard } from "@/components/admin";
import type {
  CommerceSeriesPoint,
  TrendPoint,
} from "@/types/super-admin/reports/behavior";
import { bucketText, numberText, rangeText, tomanText } from "@/components/SuperAdmin/reports/shared/format";
import { ChartTableToggle } from "@/components/SuperAdmin/reports/shared/ChartTableToggle";
import TimeSeriesChart, {
  SeriesLegend,
  type SeriesRow,
} from "@/components/SuperAdmin/reports/shared/TimeSeriesChart";
import { SectionHeader, Segmented } from "@/components/SuperAdmin/reports/shared/ui";
import { SourceLabel } from "./ui";

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

function toSeriesRows(rows: TrendRow[], unit: Unit): SeriesRow[] {
  return rows.map((row) => ({
    key: row.t,
    label: bucketText(row.t, unit),
    title: bucketText(row.t, unit),
    current: row.current,
    previous: row.previous,
    previousTitle: row.previousT ? bucketText(row.previousT, unit) : null,
    incomplete: row.incomplete,
  }));
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
  const seriesRows = useMemo(
    () => (built ? toSeriesRows(built.rows, built.unit) : null),
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
              <ChartTableToggle
                showing={showTable}
                onToggle={() => setShowTable((value) => !value)}
                controls={tableId}
              />
            ) : null}
          </>
        }
      />
      <div className="mt-3">
        <SeriesLegend
          current={`این دوره: ${rangeText(range.start, range.end)}`}
          previous={hasPrevious && previousRange ? `دوره قبل: ${rangeText(previousRange.start, previousRange.end)}` : null}
          incomplete={built?.rows.some((row) => row.incomplete)}
          lead={<SourceLabel source={definition.source} />}
        />
      </div>

      <div className="mt-4" aria-busy={loading}>
        <TimeSeriesChart
          rows={seriesRows}
          seriesLabel={definition.label}
          valueText={(value) => valueText(metric, value)}
          loading={loading}
          error={
            !loading && !built ? (unavailableReason ?? "داده روند برای این شاخص در دسترس نیست.") : null
          }
          view={showTable ? "table" : "chart"}
          tableId={tableId}
          gradientId="traffic-trend-fill"
        />
      </div>
    </AdminCard>
  );
}
