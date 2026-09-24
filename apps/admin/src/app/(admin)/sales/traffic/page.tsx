"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SalesPage from "../_components/SalesPage";
import { AdminCard, FOCUS_RING, SkeletonBlock } from "@/components/admin";
import { useReportQueryState } from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import type {
  BehaviorFilters,
  BehaviorQuery,
  BehaviorResponse,
  BreakdownDimension,
  CommerceSeriesPoint,
  PurchaseTracking,
  TrendPoint,
} from "@/types/super-admin/reports/behavior";
import { cn } from "@/utils/tailwind";
import { dateText, finite, tehranToday } from "./format";
import { filtersFromValues, URL_FILTER_KEYS } from "./filters";
import { isOpenRange } from "./funnelSemantics";
import { presentAnalyticsMessage } from "./presentation";
import AcquisitionPanel from "./_components/AcquisitionPanel";
import { AudiencePanel, PerformancePanel } from "./_components/AudiencePanels";
import ContentPanel from "./_components/ContentPanel";
import DataHealthPanel from "./_components/DataHealthPanel";
import FunnelModule, { type FunnelPerspective, type FunnelScope } from "./_components/FunnelModule";
import PulseStrip from "./_components/PulseStrip";
import { useRealtimePill } from "./_components/RealtimePill";
import TrafficToolbar from "./_components/TrafficToolbar";
import TrendChart, { type TrendMetric } from "./_components/TrendChart";
import { Notice, SectionHeader } from "./_components/ui";
import { useBehaviorView } from "./_components/useBehaviorData";

/** Deeper analyses below the fold, one existing endpoint each, loaded on demand. */
const DEEP_TABS = [
  { id: "acquisition", label: "منابع ورود", hint: "کیفیت ترافیک هر منبع و کمپین" },
  { id: "content", label: "صفحه‌ها و مسیرها", hint: "صفحه ورود، اقدام‌ها و مسیرهای واقعی" },
  { id: "audience", label: "مخاطبان", hint: "دستگاه، مکان و بازگشت" },
  { id: "performance", label: "سرعت", hint: "Core Web Vitals" },
] as const;
type DeepTab = (typeof DEEP_TABS)[number]["id"];

const EXTRA_KEYS = [
  "view",
  "compare",
  "funnel",
  "fview",
  "fdim",
  "metric",
  ...URL_FILTER_KEYS,
] as const;

function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tracking(value: unknown): PurchaseTracking | null {
  const candidate = record(value);
  return typeof candidate.status === "string" ? (candidate as unknown as PurchaseTracking) : null;
}

function seriesOf<T>(value: unknown): { unit?: "hour" | "day" | "month"; points?: T[] } | null {
  const candidate = record(value);
  return Array.isArray(candidate.points)
    ? (candidate as { unit?: "hour" | "day" | "month"; points?: T[] })
    : null;
}

/** Loads a deep tab once its section is near the viewport (or immediately without IO). */
function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  // Without IntersectionObserver (old browsers, tests) there is nothing to wait for.
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = ref.current;
    if (near || !node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near];
}

function StateBanner({
  reports,
  dataStart,
  start,
}: {
  reports: Array<{ report: BehaviorResponse | null; requestError: string | null }>;
  dataStart?: string | null;
  start: string;
}) {
  const failures = reports.filter(
    (entry) => entry.requestError || entry.report?.state === "unavailable",
  );
  const partial = reports.some((entry) => entry.report?.state === "partial");
  const empty = reports.length > 0 && reports.every((entry) => entry.report?.state === "empty");
  const beforeData = dataStart && start < dataStart.slice(0, 10);
  if (failures.length === reports.length && failures.length) {
    return (
      <Notice tone="error" title="گزارش رفتار کاربران در دسترس نیست">
        {presentAnalyticsMessage(failures[0].requestError ?? failures[0].report?.error)}
      </Notice>
    );
  }
  if (empty) {
    return (
      <Notice title="برای بازه و فیلتر انتخابی داده‌ای ثبت نشده است">
        {beforeData ? `آمار بازدید از ${dateText(dataStart?.slice(0, 10))} موجود است.` : null}
      </Notice>
    );
  }
  if (failures.length || partial) {
    const generic = "بخشی از اطلاعات این گزارش موقتاً در دسترس نیست.";
    const details = Array.from(
      new Set(
        reports
          .flatMap((entry) => [
            entry.requestError,
            entry.report?.error,
            ...(entry.report?.metadata.warnings ?? []),
          ])
          .filter((message): message is string => Boolean(message?.trim()))
          .map(presentAnalyticsMessage),
      ),
    ).filter((message) => message !== generic);
    return (
      <Notice tone="warning" title="بخشی از گزارش در دسترس نیست؛ بخش‌های موجود نمایش داده شده‌اند">
        {details.map((message) => (
          <span key={message} className="block">
            {message}
          </span>
        ))}
      </Notice>
    );
  }
  if (beforeData) {
    return <Notice>آمار بازدید از {dateText(dataStart?.slice(0, 10))} موجود است؛ روزهای پیش از آن «بدون داده» نمایش داده می‌شوند.</Notice>;
  }
  return null;
}

export default function BehaviorReportPage() {
  const { start, end, values, setRange, setValues } = useReportQueryState<(typeof EXTRA_KEYS)[number]>({
    tab: false,
    extraKeys: EXTRA_KEYS,
  });
  const compare = values.compare !== "none";
  const filterKey = URL_FILTER_KEYS.map((key) => values[key] ?? "").join("|");
  const filters = useMemo<BehaviorFilters>(
    () => filtersFromValues(values),
    // Only the filter values themselves, not the whole query bag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey],
  );
  const query = useMemo<BehaviorQuery>(
    () => ({ start, end, comparison: compare ? "previous_period" : "none", filters }),
    [compare, end, filters, start],
  );
  const deepTab = oneOf<DeepTab>(values.view, DEEP_TABS.map((tab) => tab.id), "acquisition");
  const scope = oneOf<FunnelScope>(values.funnel, ["core", "checkout", "payment", "discovery"], "core");
  const perspective = oneOf<FunnelPerspective>(values.fview, ["conversion", "dropoff", "trend", "breakdown"], "conversion");
  const dimension = oneOf<BreakdownDimension>(values.fdim, ["device", "os", "browser"], "device");
  const metric = oneOf<TrendMetric>(values.metric, ["visitors", "pageviews", "paidOrders", "revenue"], "visitors");
  const today = tehranToday();

  const overview = useBehaviorView("overview", query);
  const conversion = useBehaviorView("conversion", query);
  const [deepRef, deepNear] = useNearViewport<HTMLElement>();
  const deepRequested = deepNear || Boolean(values.view);
  const deep = useBehaviorView(deepRequested ? deepTab : null, query);
  const realtime = useRealtimePill();

  const set = useCallback(
    (updates: Record<string, string | null>) => void setValues(updates),
    [setValues],
  );
  const onFilters = useCallback(
    (next: BehaviorFilters) => {
      const updates: Record<string, string | null> = { page: "1" };
      for (const key of URL_FILTER_KEYS) updates[key] = next[key] || null;
      set(updates);
    },
    [set],
  );
  const refresh = () => {
    overview.reload(true);
    conversion.reload(true);
    deep.reload(true);
  };

  const overviewData = record(overview.report?.data);
  const overviewSections = record(overviewData.sections);
  const previousOverview = record(overviewData.comparison);
  const conversionData = record(conversion.report?.data);
  const conversionSections = record(conversionData.sections);
  const previousConversion = record(record(conversionData.comparison).sections);
  const summary = Object.keys(record(overviewData.summary ?? overviewSections.summary)).length
    ? record(overviewData.summary ?? overviewSections.summary)
    : null;
  const previousSummary = compare
    ? record(previousOverview.summary ?? record(previousOverview.sections).summary)
    : null;
  const trend = seriesOf<TrendPoint>(overviewSections.trend);
  const commerce = Object.keys(record(conversionSections.commerce)).length
    ? record(conversionSections.commerce)
    : null;
  const commerceSeries = seriesOf<CommerceSeriesPoint>(commerce?.series);
  const currentTracking = tracking(conversionSections.purchaseTracking);
  const metadata = overview.report?.metadata ?? conversion.report?.metadata;
  const previousRange = metadata?.comparisonRange ?? null;
  const summaryVisitors = finite(summary?.visitors);
  const deepData = record(deep.report?.data);
  const deepSections = record(deepData.sections);
  const refreshing = overview.loading || conversion.loading;

  return (
    <SalesPage
      title="ترافیک و تبدیل"
      description="چقدر بازدید داریم، چه سهمی از آن به خرید می‌رسد، کجا خریداران را از دست می‌دهیم و کدام منابع بازدید باکیفیت می‌آورند."
    >
      <div className="space-y-4 lg:space-y-6" dir="rtl">
        <TrafficToolbar
          start={start}
          end={end}
          onRange={setRange}
          compare={compare}
          onCompare={(enabled) => set({ compare: enabled ? "previous_period" : "none" })}
          filters={filters}
          onFilters={onFilters}
          onRefresh={refresh}
          refreshing={refreshing}
          refreshedAt={metadata?.refreshedAt}
          realtime={realtime.pill}
        />
        {realtime.panel}

        <StateBanner
          reports={[overview, conversion].filter((entry) => entry.report || entry.requestError)}
          dataStart={metadata?.dataStart}
          start={start}
        />

        <PulseStrip
          summary={summary}
          previousSummary={previousSummary}
          trendPoints={trend?.points ?? null}
          goal={conversionSections.purchaseGoal}
          previousGoal={compare ? previousConversion.purchaseGoal : undefined}
          tracking={currentTracking}
          previousTracking={compare ? tracking(previousConversion.purchaseTracking) : null}
          commerce={commerce}
          previousCommerce={compare ? record(previousConversion.commerce) : null}
          commercePoints={commerceSeries?.points ?? null}
          compare={compare}
          requestedRange={{ start, end }}
          previousRange={
            compare ? (conversion.report?.metadata.comparisonRange ?? previousRange) : null
          }
          overviewLoading={overview.loading}
          conversionLoading={conversion.loading}
          filtersActive={Object.keys(filters).length > 0}
        />

        <TrendChart
          sources={{
            trend,
            previousTrend: compare ? seriesOf<TrendPoint>(record(previousOverview.sections).trend) : null,
            commerce: commerceSeries,
            previousCommerce: compare ? seriesOf<CommerceSeriesPoint>(record(previousConversion.commerce).series) : null,
          }}
          metric={metric}
          onMetric={(next) => set({ metric: next })}
          loading={metric === "paidOrders" || metric === "revenue" ? conversion.loading : overview.loading}
          range={{ start, end }}
          previousRange={compare ? previousRange : null}
          today={today}
          unavailableReason={(() => {
            const source = (metric === "paidOrders" || metric === "revenue" ? conversion : overview).report;
            if (!source) return null;
            if (source.state === "empty") return "در این بازه داده‌ای ثبت نشده است.";
            if (source.state === "unavailable") return presentAnalyticsMessage(source.error);
            return "روند این شاخص از سرور گزارش دریافت نشد؛ اگر سرور هنوز به‌روز نشده، پس از به‌روزرسانی نمایش داده می‌شود.";
          })()}
        />

        <FunnelModule
          resource={conversion}
          query={query}
          compare={compare}
          scope={scope}
          onScope={(next) => set({ funnel: next })}
          perspective={perspective}
          onPerspective={(next) => set({ fview: next })}
          dimension={dimension}
          onDimension={(next) => set({ fdim: next })}
          openRange={isOpenRange(end, today)}
        />

        <section ref={deepRef} aria-labelledby="deep-title">
          <AdminCard>
            <SectionHeader
              id="deep-title"
              title="تحلیل عمیق‌تر"
              description="هر بخش فقط هنگام باز شدن بارگذاری می‌شود و همان بازه و فیلترهای بالای صفحه را دارد."
            />
            <div role="tablist" aria-label="بخش‌های تحلیل" className="mt-4 flex gap-1 overflow-x-auto border-b border-slate-100">
              {DEEP_TABS.map((tab) => {
                const selected = tab.id === deepTab;
                return (
                  <button
                    key={tab.id}
                    id={`deep-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls="deep-panel"
                    tabIndex={selected ? 0 : -1}
                    onClick={() => set({ view: tab.id })}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                      event.preventDefault();
                      const index = DEEP_TABS.findIndex((item) => item.id === tab.id);
                      const step = event.key === "ArrowLeft" ? 1 : -1;
                      const next = DEEP_TABS[(index + step + DEEP_TABS.length) % DEEP_TABS.length];
                      set({ view: next.id });
                      document.getElementById(`deep-tab-${next.id}`)?.focus();
                    }}
                    className={cn(
                      "-mb-px shrink-0 border-b-2 px-3 py-2.5 text-right",
                      selected
                        ? "border-infinity-primary text-slate-900"
                        : "border-transparent text-slate-600 hover:text-slate-900",
                      FOCUS_RING,
                    )}
                  >
                    <span className="block text-sm font-medium">{tab.label}</span>
                    <span className="block text-[11px] text-slate-500">{tab.hint}</span>
                  </button>
                );
              })}
            </div>
            <div
              id="deep-panel"
              role="tabpanel"
              aria-labelledby={`deep-tab-${deepTab}`}
              className={cn("mt-5", deep.loading && deep.report && "opacity-60 transition-opacity")}
            >
              {!deep.report && (deep.loading || !deepRequested) ? (
                <div className="space-y-3" aria-hidden>
                  <SkeletonBlock className="h-6 w-48" />
                  <SkeletonBlock className="h-64 w-full" />
                </div>
              ) : deep.requestError || deep.report?.state === "unavailable" ? (
                <Notice tone="warning">
                  {presentAnalyticsMessage(deep.requestError ?? deep.report?.error)}
                </Notice>
              ) : deep.report?.state === "empty" ? (
                <Notice>برای بازه و فیلتر انتخابی داده‌ای ثبت نشده است.</Notice>
              ) : deepTab === "acquisition" ? (
                <AcquisitionPanel sections={deepSections} summaryVisitors={summaryVisitors} tracking={currentTracking} />
              ) : deepTab === "content" ? (
                <ContentPanel sections={deepSections} summaryVisitors={summaryVisitors} />
              ) : deepTab === "audience" ? (
                <AudiencePanel sections={deepSections} summaryVisitors={summaryVisitors} />
              ) : (
                <PerformancePanel sections={deepSections} />
              )}
            </div>
          </AdminCard>
        </section>

        <DataHealthPanel
          sources={[
            { label: "بازدید", report: overview.report, requestError: overview.requestError },
            { label: "قیف و فروش", report: conversion.report, requestError: conversion.requestError },
            {
              label: DEEP_TABS.find((tab) => tab.id === deepTab)?.label ?? "",
              report: deep.report,
              requestError: deep.requestError,
            },
          ]}
          delivery={
            Object.keys(record(overviewSections.analyticsDelivery)).length
              ? record(overviewSections.analyticsDelivery)
              : null
          }
          tracking={currentTracking}
        />
      </div>
    </SalesPage>
  );
}
