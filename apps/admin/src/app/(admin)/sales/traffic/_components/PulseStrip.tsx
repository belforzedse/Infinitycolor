"use client";

import type { ReactNode } from "react";
import KpiCard from "@/components/SuperAdmin/reports/shared/KpiCard";
import type {
  CommerceSeriesPoint,
  PurchaseTracking,
  TrendPoint,
} from "@/types/super-admin/reports/behavior";
import { cn } from "@/utils/tailwind";
import {
  compactNumber,
  finite,
  numberText,
  pointChange,
  rangeText,
  ratioText,
  relativeChange,
  tomanText,
} from "@/components/SuperAdmin/reports/shared/format";
import { conversionRate } from "../funnelSemantics";
import { DeltaBadge } from "@/components/SuperAdmin/reports/shared/DeltaBadge";
import { SourceLabel } from "./ui";

type Summary = Record<string, unknown>;

function Figure({
  label,
  value,
  amount,
  format,
  delta,
  context,
  spark,
  loading,
  testId,
}: {
  label: string;
  value?: ReactNode;
  amount?: number | null;
  format?: (value: number) => string;
  delta?: ReactNode;
  context?: ReactNode;
  spark?: ReadonlyArray<number | null> | null;
  loading?: boolean;
  testId: string;
}) {
  return (
    <KpiCard
      surface="plain"
      testId={testId}
      title={label}
      value={value}
      amount={amount}
      format={format}
      delta={delta}
      context={context}
      spark={spark}
      loading={loading}
    />
  );
}

function Group({
  title,
  source,
  columns,
  children,
}: {
  title: string;
  source: "umami" | "commerce";
  columns: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col bg-white">
      <p className="flex flex-wrap items-baseline gap-x-2 px-4 pt-3 text-xs font-semibold text-slate-900 md:px-5">
        {title}
        <SourceLabel source={source} />
      </p>
      <div className={cn("grid flex-1 grid-cols-1 gap-px bg-slate-100", columns)}>{children}</div>
    </div>
  );
}

/**
 * The five numbers a reader checks first. Behavior comes from Umami, orders
 * and money only from the storefront database, and each figure says which.
 */
export default function PulseStrip({
  summary,
  previousSummary,
  trendPoints,
  goal,
  previousGoal,
  tracking,
  previousTracking,
  commerce,
  previousCommerce,
  commercePoints,
  compare,
  requestedRange,
  previousRange,
  overviewLoading,
  conversionLoading,
  filtersActive,
}: {
  summary: Summary | null;
  previousSummary: Summary | null;
  trendPoints: TrendPoint[] | null;
  goal: unknown;
  previousGoal: unknown;
  tracking: PurchaseTracking | null;
  previousTracking: PurchaseTracking | null;
  commerce: Summary | null;
  previousCommerce: Summary | null;
  commercePoints: CommerceSeriesPoint[] | null;
  compare: boolean;
  /** The requested windows; commerce is only compared when it covered both in full. */
  requestedRange: { start: string; end: string };
  previousRange: { start: string; end: string } | null;
  overviewLoading: boolean;
  conversionLoading: boolean;
  filtersActive: boolean;
}) {
  const visitors = finite(summary?.visitors);
  const visits = finite(summary?.visits);
  const pageviews = finite(summary?.pageviews);
  const bounces = finite(summary?.bounces);
  const bounceRate = visits && bounces !== null ? bounces / visits : null;
  const pagesPerVisit = visits && pageviews !== null ? pageviews / visits : null;
  const rate = conversionRate("visitor", {
    goal,
    previousGoal,
    tracking,
    previousTracking,
  });
  const change = (key: string, source: Summary | null, before: Summary | null) =>
    compare ? relativeChange(source?.[key], before?.[key]) : null;
  // A missing figure has nothing to compare; only a present one says «no basis».
  const deltaNode = (
    value: number | null,
    kind: "relative" | "points" = "relative",
    present = true,
  ) => (compare && present ? <DeltaBadge change={value} kind={kind} suffix="نسبت به دوره قبل" /> : null);
  const commerceNote = filtersActive ? "فیلترهای گزارش روی سفارش‌ها اعمال نمی‌شوند." : null;
  // Orders are floored at the storefront cutover (23 Shahrivar). A window the
  // floor clipped holds fewer days than it claims, so comparing it would
  // inflate or deflate the change: say so instead of printing a delta.
  const queried =
    commerce?.range && typeof commerce.range === "object"
      ? (commerce.range as { start?: string; end?: string })
      : null;
  // The window actually queried (clamped to the financial data floor).
  const commerceRange =
    queried && queried.start && queried.end && queried.start <= queried.end
      ? rangeText(queried.start, queried.end)
      : null;
  const clipped = (value: Summary | null, target: { start: string; end: string } | null) => {
    const window = value?.range as { start?: string; end?: string } | undefined;
    return Boolean(
      target && window?.start && window.end && (window.start !== target.start || window.end !== target.end),
    );
  };
  const currentClipped = clipped(commerce, requestedRange);
  const previousClipped = clipped(previousCommerce, previousRange);
  const commerceDelta = (key: "paidOrders" | "revenueToman") => {
    if (!compare || finite(commerce?.[key]) === null) return null;
    if (!currentClipped && !previousClipped) return deltaNode(change(key, commerce, previousCommerce));
    return (
      <span className="text-xs text-slate-600">
        بدون مقایسه: {currentClipped ? "این بازه" : "دوره قبل"} پیش از ۲۳ شهریور شروع می‌شود.
      </span>
    );
  };

  return (
    <section aria-label="خلاصه دوره" className="overflow-hidden rounded-prominent border border-slate-100 shadow-sm">
      <div className="grid gap-px bg-slate-100 xl:grid-cols-[3fr_2fr]">
        <Group title="بازدید و تبدیل" source="umami" columns="sm:grid-cols-3">
          <Figure
            testId="pulse-visitors"
            label="بازدیدکننده"
            loading={overviewLoading && !summary}
            amount={visitors}
            format={numberText}
            delta={deltaNode(change("visitors", summary, previousSummary), "relative", visitors !== null)}
            spark={visitors === null ? null : trendPoints?.map((point) => point.visitors ?? null)}
            context="هر دستگاه و مرورگر در یک ماه یک بازدیدکننده است."
          />
          <Figure
            testId="pulse-visits"
            label="بازدید"
            loading={overviewLoading && !summary}
            amount={visits}
            format={numberText}
            delta={deltaNode(change("visits", summary, previousSummary), "relative", visits !== null)}
            context={
              visits
                ? `پرش ${ratioText(bounceRate)} · ${numberText(pagesPerVisit, 1)} صفحه در هر بازدید`
                : null
            }
          />
          <Figure
            testId="pulse-conversion"
            label="نرخ خرید بازدیدکنندگان"
            loading={conversionLoading && rate.status === "unavailable"}
            value={
              rate.status === "incomplete" ? (
                <span className="text-base font-medium text-amber-800 md:text-lg">
                  ردیابی خرید ناقص است
                </span>
              ) : undefined
            }
            amount={rate.status === "incomplete" ? undefined : rate.rate}
            format={ratioText}
            delta={
              rate.status === "ok"
                ? deltaNode(pointChange(rate.rate, rate.previousRate), "points")
                : null
            }
            context={
              rate.status === "incomplete"
                ? "در این بازه همه خریدها در آمار ثبت نشده‌اند؛ عدد سفارش‌ها را ببینید."
                : rate.status === "unavailable"
                  ? "در دسترس نیست"
                  : `${numberText(rate.numerator)} خریدار از ${numberText(rate.denominator)} بازدیدکننده`
            }
          />
        </Group>
        <Group title="فروش" source="commerce" columns="sm:grid-cols-2">
          <Figure
            testId="pulse-orders"
            label="سفارش پرداخت‌شده"
            loading={conversionLoading && !commerce}
            amount={finite(commerce?.paidOrders)}
            format={numberText}
            delta={commerceDelta("paidOrders")}
            spark={commercePoints?.map((point) => point.paidOrders)}
            context={
              commerceNote ??
              (commerce ? `از ${numberText(commerce.totalOrders)} سفارش ثبت‌شده` : null)
            }
          />
          <Figure
            testId="pulse-revenue"
            label="درآمد خالص"
            loading={conversionLoading && !commerce}
            amount={finite(commerce?.revenueToman)}
            format={(value) => `${compactNumber(value, 2)} تومان`}
            delta={commerceDelta("revenueToman")}
            spark={commercePoints?.map((point) => point.revenueToman)}
            context={
              commerceNote ??
              (finite(commerce?.revenueToman) === null ? null : (
                <>
                  <span className="tabular-nums">{tomanText(commerce?.revenueToman)}</span>؛
                  پرداخت‌های موفق منهای مرجوعی
                </>
              ))
            }
          />
        </Group>
      </div>
      {commerce ? (
        <p className="border-t border-slate-100 bg-white px-4 py-2 text-[11px] text-slate-600 md:px-5">
          سفارش و درآمد: سفارش‌های فروشگاه جدید
          {commerceRange ? ` از ${commerceRange}` : ""}؛ سفارش‌های واردشده از سایت قدیم در این عددها
          نیستند.
        </p>
      ) : null}
    </section>
  );
}
