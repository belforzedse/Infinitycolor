"use client";

import { TrendingDown } from "lucide-react";
import { InlineLoadingState } from "@/components/admin";
import type {
  BreakdownDimension,
  ConversionBreakdownSegment,
} from "@/types/super-admin/reports/behavior";
import { numberText, ratioText } from "../format";
import { analyzeFunnel, type FunnelAnalysis } from "../funnelSemantics";
import { presentBehaviorValue, presentFunnelStep } from "../presentation";
import { AnalyticsTable, LabelCell, ShareBar } from "./AnalyticsTable";
import { Notice, Segmented } from "./ui";

export const BREAKDOWN_OPTIONS: ReadonlyArray<{ id: BreakdownDimension; label: string }> = [
  { id: "device", label: "دستگاه" },
  { id: "os", label: "سیستم‌عامل" },
  { id: "browser", label: "مرورگر" },
];

type SegmentView = {
  value: string;
  analysis: FunnelAnalysis | null;
  /** Index of the step with the lowest continuation rate in this segment. */
  weakest: number | null;
};

export function breakdownViews(
  segments: ConversionBreakdownSegment[],
  purchaseReliable: boolean,
): SegmentView[] {
  return segments.map((segment) => {
    const analysis = segment.steps
      ? analyzeFunnel(segment.steps, undefined, { purchaseReliable })
      : null;
    let weakest: number | null = null;
    for (const step of analysis?.steps.slice(1) ?? []) {
      if (step.unreliable || step.fromPrevious === null) continue;
      if (weakest === null || step.fromPrevious < (analysis!.steps[weakest].fromPrevious ?? 1)) {
        weakest = step.index;
      }
    }
    return { value: segment.value, analysis, weakest };
  });
}

/**
 * The «تفکیک» view: the same ordered funnel run once per top segment of a
 * session-level dimension. Each row reads left to right as that segment's own
 * funnel; the weakest step in each row is named, not only tinted.
 */
export default function FunnelBreakdown({
  dimension,
  onDimension,
  segments,
  loading,
  error,
  unsupported,
  stepEvents,
  purchaseReliable,
}: {
  dimension: BreakdownDimension;
  onDimension: (dimension: BreakdownDimension) => void;
  segments: ConversionBreakdownSegment[] | null;
  loading: boolean;
  error: string | null;
  unsupported: boolean;
  stepEvents: string[];
  purchaseReliable: boolean;
}) {
  const views = segments ? breakdownViews(segments, purchaseReliable) : null;
  const totalEntrants = views?.reduce((sum, view) => sum + (view.analysis?.entrants ?? 0), 0) ?? 0;
  return (
    <div className={loading && views ? "opacity-60 transition-opacity" : undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="تفکیک قیف بر اساس"
          size="sm"
          value={dimension}
          options={BREAKDOWN_OPTIONS}
          onChange={onDimension}
        />
        <p className="text-[11px] text-slate-500">۵ گروه پرتعداد این بازه</p>
      </div>
      <div className="mt-3">
        {unsupported ? (
          <Notice>تفکیک قیف به نسخه جدید سرور گزارش نیاز دارد.</Notice>
        ) : error ? (
          <Notice tone="warning">{error}</Notice>
        ) : loading && !views ? (
          <InlineLoadingState label="در حال اجرای قیف برای هر گروه…" />
        ) : !views?.length ? (
          <Notice>برای این بازه گروهی با داده پیدا نشد.</Notice>
        ) : (
          <AnalyticsTable
            caption="تفکیک قیف"
            rows={views}
            rowKey={(view) => view.value}
            minWidth={480 + stepEvents.length * 72}
            columns={[
              {
                key: "segment",
                label: BREAKDOWN_OPTIONS.find((option) => option.id === dimension)?.label ?? "",
                render: (view) => (
                  <LabelCell label={presentBehaviorValue(view.value, dimension)} raw={view.value} maxWidth={220} />
                ),
              },
              {
                key: "entrants",
                label: "ورودی قیف",
                numeric: true,
                sortValue: (view) => view.analysis?.entrants ?? null,
                render: (view) => (
                  <ShareBar
                    share={
                      totalEntrants && view.analysis
                        ? (view.analysis.entrants ?? 0) / totalEntrants
                        : null
                    }
                  >
                    {numberText(view.analysis?.entrants)}
                  </ShareBar>
                ),
              },
              ...stepEvents.slice(1).map((event, index) => ({
                key: `step-${index + 1}`,
                label: presentFunnelStep(event),
                hint: "از مرحله قبل",
                numeric: true,
                className: "whitespace-normal",
                sortValue: (view: SegmentView) =>
                  view.analysis?.steps[index + 1]?.fromPrevious ?? null,
                render: (view: SegmentView) => {
                  const step = view.analysis?.steps[index + 1];
                  if (!view.analysis) return "—";
                  if (step?.unreliable) return <span className="text-slate-500">ناقص</span>;
                  const weakest = view.weakest === index + 1;
                  return (
                    <span
                      className={weakest ? "inline-flex items-center gap-1 font-semibold text-rose-800" : undefined}
                    >
                      {weakest ? <TrendingDown aria-hidden className="size-3" /> : null}
                      {ratioText(step?.fromPrevious)}
                      {weakest ? <span className="sr-only">(ضعیف‌ترین مرحله این گروه)</span> : null}
                    </span>
                  );
                },
              })),
              {
                key: "overall",
                label: "کل قیف",
                hint: "از ورودی‌ها",
                numeric: true,
                sortValue: (view) =>
                  view.analysis &&
                  view.analysis.lastReliableIndex === view.analysis.steps.length - 1
                    ? view.analysis.overall
                    : null,
                render: (view) =>
                  view.analysis &&
                  view.analysis.lastReliableIndex === view.analysis.steps.length - 1
                    ? ratioText(view.analysis.overall)
                    : "—",
              },
            ]}
          />
        )}
      </div>
      <p className="mt-3 text-[11px] leading-5 text-slate-600">
        <TrendingDown aria-hidden className="inline size-3 align-[-2px] text-rose-800" /> ضعیف‌ترین
        مرحله هر گروه. منبع ورود و کمپین (UTM) در Umami به هر رخداد جداگانه تعلق دارند، نه به
        بازدیدکننده؛ قیف با آن‌ها فقط کسانی را می‌شمرد که خودِ رخداد مرحله اول‌شان آن منبع را داشت، نه
        همه کسانی که آن منبع آورده است. کیفیت منابع ورود را در بخش «منابع ورود» ببینید.
      </p>
    </div>
  );
}
