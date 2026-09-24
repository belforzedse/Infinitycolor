"use client";

import { useMemo } from "react";
import { AdminCard, SkeletonBlock } from "@/components/admin";
import type {
  BehaviorFilters,
  BehaviorQuery,
  BreakdownDimension,
  CommerceSeriesPoint,
  ConversionBreakdownSegment,
  ConversionTrendBucket,
  FunnelKey,
  PurchaseTracking,
  StepFilterScope,
} from "@/types/super-admin/reports/behavior";
import { numberText, ratioText } from "@/components/SuperAdmin/reports/shared/format";
import { FILTER_LABELS } from "../filters";
import {
  analyzeFunnel,
  conversionRate,
  purchaseTrackingReliable,
  type ConversionDefinitionId,
} from "../funnelSemantics";
import { presentAnalyticsMessage, presentFunnelStep, presentWindow } from "../presentation";
import ConversionRates from "./ConversionRates";
import FunnelBars from "./FunnelBars";
import FunnelBreakdown from "./FunnelBreakdown";
import FunnelDropoff from "./FunnelDropoff";
import FunnelTrend, { trendBucketViews } from "./FunnelTrend";
import { DeltaBadge } from "@/components/SuperAdmin/reports/shared/DeltaBadge";
import { Notice, SectionHeader, Segmented } from "@/components/SuperAdmin/reports/shared/ui";
import { useConversionDetail, type Resource } from "./useBehaviorData";

export type FunnelScope = FunnelKey | "discovery";
export type FunnelPerspective = "conversion" | "dropoff" | "trend" | "breakdown";

const FUNNEL_LABELS: Record<FunnelScope, { label: string; section: string; fallbackWindow: number }> = {
  core: { label: "مسیر کامل خرید", section: "coreFunnel", fallbackWindow: 1440 },
  checkout: { label: "ثبت سفارش", section: "checkoutFunnel", fallbackWindow: 60 },
  payment: { label: "درگاه پرداخت", section: "paymentFunnel", fallbackWindow: 60 },
  discovery: { label: "کشف محصول", section: "discoveryFunnel", fallbackWindow: 1440 },
};

const PERSPECTIVES: ReadonlyArray<{ id: FunnelPerspective; label: string }> = [
  { id: "conversion", label: "تبدیل" },
  { id: "dropoff", label: "ریزش" },
  { id: "trend", label: "روند" },
  { id: "breakdown", label: "تفکیک" },
];

type Sections = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tracking(value: unknown): PurchaseTracking | null {
  const candidate = record(value);
  return typeof candidate.status === "string" ? (candidate as unknown as PurchaseTracking) : null;
}

/** Scopes this API answered with; an older API has no end-to-end funnel. */
export function availableFunnels(
  sections: Sections,
  errors: Record<string, unknown>,
): FunnelScope[] {
  // An older API answers with the discovery funnel and no end-to-end one.
  const hasCore =
    Array.isArray(sections.coreFunnel) ||
    "coreFunnel" in errors ||
    !Array.isArray(sections.discoveryFunnel);
  return hasCore ? ["core", "checkout", "payment"] : ["discovery", "checkout", "payment"];
}

function SummaryFigure({ label, value, detail }: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div className="min-w-0 bg-white px-4 py-3">
      <p className="text-[11px] font-medium text-slate-600">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
      {detail ? <div className="mt-0.5 text-[11px] leading-4 text-slate-600">{detail}</div> : null}
    </div>
  );
}

export default function FunnelModule({
  resource,
  query,
  compare,
  scope,
  onScope,
  perspective,
  onPerspective,
  dimension,
  onDimension,
  openRange,
}: {
  resource: Resource;
  query: BehaviorQuery;
  compare: boolean;
  scope: FunnelScope;
  onScope: (scope: FunnelScope) => void;
  perspective: FunnelPerspective;
  onPerspective: (perspective: FunnelPerspective) => void;
  dimension: BreakdownDimension;
  onDimension: (dimension: BreakdownDimension) => void;
  /** The range runs to today, so recent visitors are still inside their window. */
  openRange: boolean;
}) {
  const payload = record(resource.report?.data);
  const sections: Sections = record(payload.sections);
  const errors = record(payload.errors);
  const previous = record(record(payload.comparison).sections);
  const funnels = availableFunnels(sections, errors);
  const activeScope: FunnelScope = funnels.includes(scope) ? scope : funnels[0];
  const meta = FUNNEL_LABELS[activeScope];
  const definitions = record(sections.funnelDefinitions);
  const windowText = presentWindow(record(definitions[activeScope]).window ?? meta.fallbackWindow);
  const currentTracking = tracking(sections.purchaseTracking);
  const previousTracking = tracking(previous.purchaseTracking);
  const reliable = purchaseTrackingReliable(currentTracking);
  const analysis = useMemo(
    () =>
      analyzeFunnel(sections[meta.section], compare ? previous[meta.section] : undefined, {
        purchaseReliable: reliable,
        previousPurchaseReliable: purchaseTrackingReliable(previousTracking),
      }),
    // `sections`/`previous` are rebuilt each render from the same report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resource.report, compare, meta.section, reliable, previousTracking],
  );
  const stepFilters = record(sections.stepFilters) as Partial<StepFilterScope>;
  const ignored = (stepFilters.ignored ?? []).filter((key) => key in FILTER_LABELS);
  const detailScope: FunnelKey | null = activeScope === "discovery" ? null : activeScope;

  const trendResource = useConversionDetail(
    perspective === "trend" && detailScope ? { detail: "trend", funnel: detailScope } : null,
    query,
  );
  const breakdownResource = useConversionDetail(
    perspective === "breakdown" && detailScope
      ? { detail: "breakdown", funnel: detailScope, dimension }
      : null,
    query,
  );
  const commercePoints = (record(record(sections.commerce).series).points ?? null) as
    | CommerceSeriesPoint[]
    | null;
  const trendData = record(trendResource.report?.data);
  const trendViews = useMemo(
    () =>
      trendData.kind === "conversion-trend" && Array.isArray(record(trendData.sections).buckets)
        ? trendBucketViews(
            record(trendData.sections).buckets as ConversionTrendBucket[],
            commercePoints,
            // A segment's purchases cannot be reconciled with the unfiltered ledger per bucket.
            ((record(record(trendData.sections).stepFilters).applied as unknown[] | undefined) ?? [])
              .length
              ? reliable
              : null,
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trendResource.report, commercePoints, reliable],
  );
  const breakdownData = record(breakdownResource.report?.data);

  const conversionInputs = {
    goal: sections.purchaseGoal,
    previousGoal: compare ? previous.purchaseGoal : undefined,
    core: sections.coreFunnel,
    previousCore: compare ? previous.coreFunnel : undefined,
    checkout: sections.checkoutFunnel,
    previousCheckout: compare ? previous.checkoutFunnel : undefined,
    tracking: currentTracking,
    previousTracking: compare ? previousTracking : null,
  };
  // Each definition's per-bucket rate, when the loaded trend covers its funnel.
  const trendFunnelFor: Record<ConversionDefinitionId, FunnelKey | null> = {
    visitor: null,
    product: "core",
    cart: "core",
    checkout: "checkout",
  };
  const sparklines: Partial<Record<ConversionDefinitionId, Array<number | null>>> = {};
  if (trendViews) {
    for (const id of Object.keys(trendFunnelFor) as ConversionDefinitionId[]) {
      const funnelKey = trendFunnelFor[id];
      if (funnelKey !== null && funnelKey !== detailScope) continue;
      sparklines[id] = trendViews.map((view) => {
        if (view.bucket.incomplete || !view.analysis) return null;
        if (id === "visitor") return view.visitorRate;
        const tracked = { status: view.purchaseReliable ? "live" : "not_live" } as PurchaseTracking;
        return conversionRate(id, {
          core: view.bucket.steps,
          checkout: view.bucket.steps,
          tracking: tracked,
        }).rate;
      });
    }
  }

  const detailError = (detail: Resource) =>
    detail.requestError || detail.report?.state === "unavailable"
      ? presentAnalyticsMessage(detail.requestError ?? detail.report?.error)
      : null;
  const sectionError = errors[meta.section] ?? (resource.report?.state === "unavailable" ? resource.report.error : null);
  const lastStep = analysis ? analysis.steps[analysis.lastReliableIndex] : null;
  const largest = analysis?.largestDrop ? analysis.steps[analysis.largestDrop.index] : null;

  return (
    <AdminCard>
      <SectionHeader
        id="funnel-title"
        title="قیف خرید و نرخ تبدیل"
        description={
          <>
            هر مرحله فقط بازدیدکنندگانی را می‌شمارد که همه مراحل قبل را به ترتیب انجام داده‌اند
            {windowText ? `، هر مرحله حداکثر ${windowText} پس از مرحله قبل` : ""}. واحد: بازدیدکننده (نشست
            Umami: یک دستگاه و مرورگر).
          </>
        }
        actions={
          <Segmented
            label="قیف"
            value={activeScope}
            options={funnels.map((id) => ({ id, label: FUNNEL_LABELS[id].label }))}
            onChange={onScope}
          />
        }
      />

      {funnels[0] === "discovery" && resource.report ? (
        <Notice className="mt-3">
          سرور گزارش هنوز قیف کامل را ارائه نمی‌دهد؛ تا به‌روزرسانی آن، قیف‌های جداگانه نمایش داده
          می‌شوند.
        </Notice>
      ) : null}

      {resource.loading && !resource.report ? (
        <div className="mt-5 space-y-3" aria-hidden>
          <SkeletonBlock className="h-16 w-full" />
          {Array.from({ length: 5 }).map((_, index) => (
            <SkeletonBlock key={index} className="h-5" />
          ))}
        </div>
      ) : resource.report?.state === "empty" ? (
        <Notice className="mt-4">در این بازه داده‌ای ثبت نشده است.</Notice>
      ) : resource.requestError || !analysis ? (
        <Notice tone="warning" className="mt-4">
          {presentAnalyticsMessage(
            resource.requestError ?? sectionError ?? "این قیف در دسترس نیست",
          )}
        </Notice>
      ) : (
        <div className={resource.loading ? "opacity-60 transition-opacity" : undefined}>
          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-control border border-slate-100 bg-slate-100 lg:grid-cols-4">
            <SummaryFigure
              label={`ورودی قیف: ${presentFunnelStep(analysis.steps[0].event)}`}
              value={numberText(analysis.entrants)}
            />
            <SummaryFigure
              label={`رسیدند به «${presentFunnelStep(lastStep?.event)}»`}
              value={numberText(analysis.completed)}
              detail={analysis.trackingIncomplete ? "مرحله خرید به‌دلیل ثبت ناقص حساب نشده" : null}
            />
            <SummaryFigure
              label="تبدیل کل قیف"
              value={ratioText(analysis.overall)}
              detail={
                <>
                  از ورودی‌ها
                  {compare ? (
                    <DeltaBadge className="ms-2" change={analysis.overallChangePp} kind="points" />
                  ) : null}
                </>
              }
            />
            <SummaryFigure
              label="بیشترین ریزش"
              value={largest ? `${numberText(largest.lost)} نفر` : "—"}
              detail={
                largest
                  ? `${presentFunnelStep(analysis.steps[largest.index - 1].event)} ← ${presentFunnelStep(largest.event)} (${ratioText(largest.dropoffRate)})`
                  : analysis.hasEntrants
                    ? "ریزشی ثبت نشده"
                    : "ورودی‌ای در این بازه نبود"
              }
            />
          </div>

          <div className="mt-3 space-y-2">
            {ignored.length ? (
              <Notice>
                این فیلترها روی قیف و نرخ تبدیل اعمال نشدند، چون در Umami به هر رخداد جداگانه تعلق
                دارند: {ignored.map((key) => FILTER_LABELS[key as keyof BehaviorFilters]).join("، ")}.
              </Notice>
            ) : null}
            {openRange ? (
              <Notice>
                بازه تا امروز ادامه دارد؛ بازدیدکنندگان ساعت‌های اخیر هنوز فرصت کامل خرید نداشته‌اند،
                پس نرخ‌ها کمی کمتر از مقدار نهایی‌اند.
              </Notice>
            ) : null}
          </div>

          <div className="mt-5">
            <div className="min-w-0">
              <Segmented
                label="نمای قیف"
                value={perspective}
                options={PERSPECTIVES.map((item) => ({
                  ...item,
                  disabled: (item.id === "trend" || item.id === "breakdown") && !detailScope,
                  hint:
                    (item.id === "trend" || item.id === "breakdown") && !detailScope
                      ? "به نسخه جدید سرور گزارش نیاز دارد"
                      : undefined,
                }))}
                onChange={onPerspective}
              />
              <div className="mt-4" role="region" aria-label={`نمای ${PERSPECTIVES.find((item) => item.id === perspective)?.label}`}>
                {!analysis.hasEntrants ? (
                  <Notice>در این بازه هیچ بازدیدکننده‌ای وارد این قیف نشده است (صفر واقعی، نه داده ناموجود).</Notice>
                ) : perspective === "conversion" ? (
                  <FunnelBars analysis={analysis} compare={compare && analysis.comparable} label={`مراحل ${meta.label}`} />
                ) : perspective === "dropoff" ? (
                  <FunnelDropoff
                    analysis={analysis}
                    compare={compare && analysis.comparable}
                    query={query}
                    funnelLabel={meta.label}
                    events={sections.event}
                  />
                ) : perspective === "trend" ? (
                  <FunnelTrend
                    views={trendViews}
                    loading={trendResource.loading}
                    error={detailError(trendResource)}
                    unsupported={Boolean(trendResource.report?.data) && trendData.kind !== "conversion-trend"}
                    stepEvents={analysis.steps.map((step) => step.event)}
                  />
                ) : (
                  <FunnelBreakdown
                    dimension={dimension}
                    onDimension={onDimension}
                    segments={
                      breakdownData.kind === "conversion-breakdown" &&
                      Array.isArray(record(breakdownData.sections).segments)
                        ? (record(breakdownData.sections).segments as ConversionBreakdownSegment[])
                        : null
                    }
                    loading={breakdownResource.loading}
                    error={detailError(breakdownResource)}
                    unsupported={
                      Boolean(breakdownResource.report?.data) &&
                      breakdownData.kind !== "conversion-breakdown"
                    }
                    stepEvents={analysis.steps.map((step) => step.event)}
                    purchaseReliable={reliable}
                  />
                )}
              </div>
            </div>
            <div className="mt-6 border-t border-slate-100 pt-5">
              <ConversionRates inputs={conversionInputs} compare={compare} sparklines={sparklines} />
            </div>
          </div>
        </div>
      )}
    </AdminCard>
  );
}
