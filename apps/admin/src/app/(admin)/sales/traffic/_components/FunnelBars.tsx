"use client";

import { AlertTriangle, ArrowDown, TrendingDown } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { faNum } from "@/utils/faNum";
import type { FunnelAnalysis, FunnelStepView } from "../funnelSemantics";
import { numberText, ratioText } from "../format";
import { presentFunnelStep } from "../presentation";
import { COMPARISON_COLOR, Delta, SERIES_COLOR } from "./ui";

const HATCH =
  "repeating-linear-gradient(135deg, #cbd5e1 0 4px, #f1f5f9 4px 8px)";

function Transition({
  step,
  from,
  largest,
  compare,
}: {
  step: FunnelStepView;
  from: FunnelStepView;
  largest: boolean;
  compare: boolean;
}) {
  if (step.unreliable) {
    return (
      <p className="flex items-center gap-1.5 py-1.5 text-xs text-amber-800 md:ps-[212px]">
        <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
        ردیابی خرید در این بازه کامل نیست؛ این مرحله در نرخ‌ها و ریزش‌ها حساب نشده است.
      </p>
    );
  }
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs text-slate-700 md:ps-[212px]",
      )}
    >
      <span className="inline-flex items-center gap-1">
        <ArrowDown aria-hidden className="size-3.5 text-slate-500" />
        <strong className="font-semibold text-slate-900">{ratioText(step.fromPrevious)}</strong>
        <span>از «{presentFunnelStep(from.event)}» ادامه دادند</span>
      </span>
      <span className="text-slate-400" aria-hidden>
        ·
      </span>
      <span className={cn(largest && "font-medium text-rose-800")}>
        {numberText(step.lost)} نفر ریزش ({ratioText(step.dropoffRate)})
      </span>
      {largest ? (
        <span className="inline-flex items-center gap-1 rounded-sm border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-800">
          <TrendingDown aria-hidden className="size-3" />
          بیشترین ریزش
        </span>
      ) : null}
      {compare && step.previous ? (
        <Delta change={step.fromPreviousChangePp} kind="points" suffix="نسبت به دوره قبل" />
      ) : null}
    </div>
  );
}

/**
 * The «تبدیل» view: one bar per step, its length the true share of funnel
 * entrants (no minimum except a hairline, no logarithm), with the exact count
 * and share printed beside it, and the step-to-step rate between bars. The
 * previous period is a slate tick on each track.
 */
export default function FunnelBars({
  analysis,
  compare,
  label,
}: {
  analysis: FunnelAnalysis;
  compare: boolean;
  label: string;
}) {
  return (
    <ol className="space-y-0.5" aria-label={label}>
      {analysis.steps.map((step, index) => {
        const share = step.shareOfEntrants;
        const width = share === null ? 0 : Math.max(share > 0 ? 0.4 : 0, share * 100);
        const previousShare = step.previous?.shareOfEntrants ?? null;
        const largest = analysis.largestDrop?.index === step.index;
        return (
          <li key={`${step.event}-${index}`}>
            {index > 0 ? (
              <Transition
                step={step}
                from={analysis.steps[index - 1]}
                largest={largest}
                compare={compare}
              />
            ) : null}
            <div className="grid items-center gap-x-3 gap-y-1.5 md:grid-cols-[200px_minmax(0,1fr)_232px]">
              <p className="flex min-w-0 items-baseline gap-2 text-sm">
                <span className="w-4 shrink-0 text-xs font-medium tabular-nums text-slate-500">
                  {faNum(index + 1)}
                </span>
                <span className="min-w-0 truncate font-medium text-slate-900" title={step.event}>
                  {presentFunnelStep(step.event)}
                </span>
              </p>
              <div
                className="relative h-5 rounded-sm bg-slate-100"
                role="presentation"
                aria-hidden
              >
                <div
                  className="absolute inset-y-0 right-0 rounded-l-[4px]"
                  style={{
                    width: `${Math.min(100, width)}%`,
                    background: step.unreliable ? HATCH : SERIES_COLOR,
                  }}
                />
                {compare && previousShare !== null && !step.unreliable ? (
                  <div
                    className="absolute -inset-y-1 w-0.5 rounded"
                    style={{
                      right: `calc(${Math.min(100, previousShare * 100)}% - 1px)`,
                      background: COMPARISON_COLOR,
                    }}
                    title={`دوره قبل: ${ratioText(previousShare)} از ورودی‌ها`}
                  />
                ) : null}
              </div>
              <p className="flex flex-wrap items-baseline justify-end gap-x-2 text-xs text-slate-600 md:justify-start">
                <strong
                  className={cn(
                    "text-sm font-semibold tabular-nums",
                    step.unreliable ? "text-slate-500" : "text-slate-900",
                  )}
                >
                  {numberText(step.count)}
                </strong>
                <span className="tabular-nums">
                  {step.unreliable
                    ? "ثبت ناقص"
                    : index === 0
                      ? "ورودی قیف"
                      : `${ratioText(share)} از ورودی‌ها`}
                </span>
                {compare && step.previous && index > 0 && !step.unreliable ? (
                  <span className="text-[11px] text-slate-500">
                    دوره قبل {ratioText(step.previous.shareOfEntrants)}
                  </span>
                ) : null}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
