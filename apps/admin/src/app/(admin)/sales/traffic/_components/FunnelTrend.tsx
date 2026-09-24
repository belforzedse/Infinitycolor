"use client";

import { useId, useMemo, useState } from "react";
import { ChartSkeleton, FOCUS_RING } from "@/components/admin";
import { cn } from "@/utils/tailwind";
import {
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
  ConversionTrendBucket,
} from "@/types/super-admin/reports/behavior";
import { dateText, numberText, percentText, ratioText } from "../format";
import {
  analyzeFunnel,
  paidOrdersBetween,
  trackingStatusFor,
  type FunnelAnalysis,
} from "../funnelSemantics";
import { presentFunnelStep } from "../presentation";
import { AnalyticsTable } from "./AnalyticsTable";
import { Notice, SERIES_COLOR, TableToggle } from "./ui";

export type TrendBucketView = {
  bucket: ConversionTrendBucket;
  label: string;
  analysis: FunnelAnalysis | null;
  /** Share of all visitors in the bucket who purchased (the purchase goal). */
  visitorRate: number | null;
  purchaseReliable: boolean;
};

function bucketLabel(bucket: ConversionTrendBucket): string {
  return bucket.days === 1
    ? dateText(bucket.startDate, false)
    : `${dateText(bucket.startDate, false)} – ${dateText(bucket.endDate, false)}`;
}

/**
 * Per-bucket funnel analyses. A bucket's purchase numbers are trusted only when
 * its own Umami purchases reconcile with that bucket's paid orders, so a range
 * straddling the day purchase tracking went live shows the gap honestly.
 *
 * With a segment filter the bucket's purchases are that segment's only, while
 * the orders ledger is never filtered, so the two cannot be reconciled per
 * bucket; `segmentReliable` (the page-level verdict) is used instead.
 */
export function trendBucketViews(
  buckets: ConversionTrendBucket[],
  commercePoints: CommerceSeriesPoint[] | null,
  segmentReliable: boolean | null = null,
): TrendBucketView[] {
  return buckets.map((bucket) => {
    const sessions =
      bucket.purchaseGoal && typeof bucket.purchaseGoal.num === "number"
        ? bucket.purchaseGoal.num
        : null;
    const status = trackingStatusFor(
      sessions,
      paidOrdersBetween(commercePoints, bucket.startDate, bucket.endDate),
    );
    const purchaseReliable =
      segmentReliable ?? (status !== "not_live" && status !== "degraded");
    const total =
      bucket.purchaseGoal && typeof bucket.purchaseGoal.total === "number"
        ? bucket.purchaseGoal.total
        : null;
    return {
      bucket,
      label: bucketLabel(bucket),
      analysis:
        bucket.beforeDataStart || !bucket.steps
          ? null
          : analyzeFunnel(bucket.steps, undefined, { purchaseReliable }),
      visitorRate:
        purchaseReliable && sessions !== null && total ? sessions / total : null,
      purchaseReliable,
    };
  });
}

type RateId = "overall" | `step-${number}`;

function rateFor(view: TrendBucketView, id: RateId): number | null {
  const analysis = view.analysis;
  if (!analysis) return null;
  if (id === "overall") {
    // Only an end-to-end rate: a bucket whose purchase step is withheld has none.
    return analysis.lastReliableIndex === analysis.steps.length - 1 ? analysis.overall : null;
  }
  const step = analysis.steps[Number(id.slice(5))];
  return step && !step.unreliable ? step.fromPrevious : null;
}

export default function FunnelTrend({
  views,
  loading,
  error,
  unsupported,
  stepEvents,
}: {
  views: TrendBucketView[] | null;
  loading: boolean;
  error: string | null;
  unsupported: boolean;
  stepEvents: string[];
}) {
  const [rateId, setRateId] = useState<RateId>("overall");
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const options = useMemo(
    () => [
      { id: "overall" as RateId, label: "کل قیف (از ورودی تا آخرین مرحله)" },
      ...stepEvents.slice(1).map((event, index) => ({
        id: `step-${index + 1}` as RateId,
        label: `${presentFunnelStep(stepEvents[index])} ← ${presentFunnelStep(event)}`,
      })),
    ],
    [stepEvents],
  );
  const rows = useMemo(() => {
    const list = views ?? [];
    const firstOpen = list.findIndex((view) => view.bucket.incomplete);
    return list.map((view, index) => {
      const rate = rateFor(view, rateId);
      const percent = rate === null ? null : rate * 100;
      return {
        ...view,
        value: percent,
        settled: view.bucket.incomplete ? null : percent,
        // The dashed tail starts at the last settled bucket so the line stays joined.
        open: firstOpen >= 0 && index >= firstOpen - 1 ? percent : null,
      };
    });
  }, [rateId, views]);

  if (unsupported) return <Notice>روند تبدیل به نسخه جدید سرور گزارش نیاز دارد.</Notice>;
  if (error) return <Notice tone="warning">{error}</Notice>;
  if (loading && !views) return <ChartSkeleton className="h-[280px]" />;
  if (!views?.length) return <Notice>برای این بازه داده‌ای وجود ندارد.</Notice>;

  const hasPoints = rows.some((row) => row.value !== null);
  const selectedLabel = options.find((option) => option.id === rateId)?.label ?? "";
  const lastOpen = rows.findIndex((row) => row.bucket.incomplete);

  return (
    <div className={loading ? "opacity-60 transition-opacity" : undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-700">
          نرخ
          <select
            value={rateId}
            onChange={(event) => setRateId(event.target.value as RateId)}
            className={cn(
              "h-8 min-w-0 max-w-full rounded-control border border-slate-200 bg-white px-2 text-xs text-slate-800",
              FOCUS_RING,
            )}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <TableToggle showing={showTable} onToggle={() => setShowTable((v) => !v)} controls={tableId} />
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600">
        {rateId === "overall"
          ? "سهم ورودی‌های هر دوره که تا آخرین مرحله رسیدند."
          : `سهم رسیدگان به «${selectedLabel.split(" ← ")[0]}» که مرحله بعد را هم انجام دادند.`}{" "}
        هر دوره جداگانه حساب می‌شود؛ بازدیدکننده‌ای که نزدیک پایان دوره وارد شده ممکن است در
        دوره بعد خرید کند.
        {lastOpen >= 0 ? " دوره‌های ناتمام با خط‌چین نمایش داده شده‌اند." : ""}
      </p>
      {showTable ? (
        <div id={tableId} className="mt-3">
          <AnalyticsTable
            caption="روند نرخ‌های قیف"
            rows={views}
            rowKey={(view) => view.bucket.startDate}
            minWidth={420 + stepEvents.length * 72}
            dense
            columns={[
              {
                key: "bucket",
                label: "دوره",
                render: (view) => (
                  <span>
                    {view.label}
                    {view.bucket.beforeDataStart ? (
                      <span className="text-slate-500"> (پیش از شروع آمار)</span>
                    ) : view.bucket.incomplete ? (
                      <span className="text-slate-500"> (ناتمام)</span>
                    ) : null}
                  </span>
                ),
              },
              {
                key: "entrants",
                label: "ورودی قیف",
                numeric: true,
                render: (view) => numberText(view.analysis?.entrants),
              },
              ...stepEvents.slice(1).map((event, index) => ({
                key: `step-${index + 1}`,
                label: presentFunnelStep(event),
                hint: "از مرحله قبل",
                numeric: true,
                className: "whitespace-normal",
                render: (view: TrendBucketView) => {
                  const step = view.analysis?.steps[index + 1];
                  return step?.unreliable ? "ناقص" : ratioText(step?.fromPrevious);
                },
              })),
              {
                key: "overall",
                label: "کل قیف",
                numeric: true,
                render: (view) => ratioText(rateFor(view, "overall")),
              },
              {
                key: "visitor",
                label: "بازدیدکننده ← خرید",
                numeric: true,
                render: (view) => (view.purchaseReliable ? ratioText(view.visitorRate) : "ناقص"),
              },
            ]}
          />
        </div>
      ) : !hasPoints ? (
        <Notice className="mt-3">
          این نرخ در هیچ دوره‌ای قابل محاسبه نیست (ورودی صفر یا ثبت ناقص خرید).
        </Notice>
      ) : (
        <div className="mt-3 h-[280px]" dir="ltr" role="img" aria-label={`روند نرخ ${selectedLabel}؛ مقدارهای دقیق در «نمایش جدول»`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
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
                width={48}
                domain={[0, "auto"]}
                tickFormatter={(value: number) => percentText(value, 0)}
              />
              <Tooltip
                cursor={{ stroke: "#94a3b8", strokeWidth: 1 }}
                content={({ active, payload }) => {
                  const row = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                  if (!active || !row) return null;
                  return (
                    <div dir="rtl" className="rounded-control border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
                      <p className="text-slate-600">
                        {row.label}
                        {row.bucket.incomplete ? " (ناتمام)" : ""}
                      </p>
                      <p className="mt-1 font-semibold tabular-nums text-slate-900">
                        {percentText(row.value, 2)}
                      </p>
                      <p className="text-slate-600">ورودی قیف: {numberText(row.analysis?.entrants)}</p>
                    </div>
                  );
                }}
              />
              <Line
                type="monotone"
                dataKey="settled"
                stroke={SERIES_COLOR}
                strokeWidth={2}
                dot={{ r: 3, fill: SERIES_COLOR, stroke: "#fff", strokeWidth: 2 }}
                isAnimationActive={false}
                connectNulls={false}
              />
              <Line
                type="monotone"
                dataKey="open"
                stroke={SERIES_COLOR}
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
                legendType="none"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
