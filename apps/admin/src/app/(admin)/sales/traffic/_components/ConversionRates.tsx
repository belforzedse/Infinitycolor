"use client";

import { CheckCircle2, CircleHelp, AlertTriangle } from "lucide-react";
import type { PurchaseTracking } from "@/types/super-admin/reports/behavior";
import { cn } from "@/utils/tailwind";
import { numberText, ratioText } from "../format";
import {
  CONVERSION_DEFINITIONS,
  conversionRate,
  type ConversionDefinitionId,
} from "../funnelSemantics";
import { Delta, Sparkline } from "./ui";

type Inputs = Parameters<typeof conversionRate>[1];

const TRACKING_TEXT: Record<PurchaseTracking["status"], { title: string; tone: "ok" | "warn" | "muted" }> = {
  live: { title: "خریدها در آمار کامل ثبت می‌شوند", tone: "ok" },
  degraded: { title: "بخشی از خریدهای این بازه در آمار ثبت نشده‌اند", tone: "warn" },
  not_live: { title: "خریدهای این بازه در آمار ثبت نشده‌اند", tone: "warn" },
  unknown: { title: "سفارش‌های این بازه برای سنجش ثبت خرید کم است", tone: "muted" },
  unavailable: { title: "ثبت خرید قابل سنجش نیست", tone: "muted" },
};

export function PurchaseReconciliation({ tracking }: { tracking: PurchaseTracking | null }) {
  if (!tracking) {
    return (
      <p className="text-[11px] leading-5 text-slate-600">
        تطبیق خریدهای آمار با سفارش‌ها به نسخه جدید سرور گزارش نیاز دارد.
      </p>
    );
  }
  const text = TRACKING_TEXT[tracking.status];
  const Icon = text.tone === "ok" ? CheckCircle2 : text.tone === "warn" ? AlertTriangle : CircleHelp;
  return (
    <div
      className={cn(
        "rounded-control border px-3 py-2 text-[11px] leading-5",
        text.tone === "warn"
          ? "border-amber-200 bg-amber-50 text-amber-900"
          : "border-slate-200 bg-slate-50 text-slate-700",
      )}
      data-testid="purchase-reconciliation"
      data-status={tracking.status}
    >
      <p className="flex items-center gap-1.5 font-medium">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {text.title}
      </p>
      <p className="mt-1">
        خرید ثبت‌شده در آمار: {numberText(tracking.umamiPurchaseSessions)} بازدیدکننده · سفارش
        پرداخت‌شده در فروشگاه: {numberText(tracking.commercePaidOrders)}
        {tracking.coverage !== null ? ` · پوشش ${ratioText(tracking.coverage)}` : ""}
      </p>
      <p className="mt-1 text-[10px] opacity-90">
        آمار همیشه کمی کمتر از سفارش‌ها است (مسدودکننده تبلیغ، بستن صفحه پیش از نتیجه پرداخت).
        عدد سفارش و درآمد فقط از پایگاه داده فروشگاه می‌آید.
      </p>
    </div>
  );
}

/**
 * The conversion definitions side by side, all visible at once. Every rate
 * ends at `purchase`, is counted in Umami visitors (sessions), and names its
 * numerator and denominator.
 */
export default function ConversionRates({
  inputs,
  compare,
  sparklines,
}: {
  inputs: Inputs;
  compare: boolean;
  /** Per-bucket values per definition, once the «روند» view has loaded them. */
  sparklines: Partial<Record<ConversionDefinitionId, ReadonlyArray<number | null>>>;
}) {
  return (
    <section aria-labelledby="conversion-rates-title" className="space-y-3" data-testid="conversion-rates">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h4 id="conversion-rates-title" className="text-sm font-semibold text-slate-900">
          نرخ تبدیل
        </h4>
        <p className="text-[11px] text-slate-600">
          همه نرخ‌ها به خرید ختم می‌شوند و با بازدیدکننده (نشست Umami) شمرده می‌شوند.
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-control border border-slate-100 bg-slate-100 sm:grid-cols-2 xl:grid-cols-4">
        {CONVERSION_DEFINITIONS.map((definition) => {
          const rate = conversionRate(definition.id, inputs);
          const spark = sparklines[definition.id];
          return (
            <div key={definition.id} className="flex min-w-0 flex-col gap-1 bg-white px-4 py-3" data-testid={`rate-${definition.id}`}>
              <dt className="text-xs font-medium text-slate-700">{definition.label}</dt>
              <dd className="flex min-w-0 flex-col gap-1">
                <span className="flex items-end justify-between gap-2">
                  <span className="whitespace-nowrap text-lg font-semibold text-slate-900">
                    {rate.status === "incomplete" ? (
                      <span className="text-sm font-medium text-amber-800">ردیابی خرید ناقص</span>
                    ) : rate.status === "no_denominator" ? (
                      <span className="text-sm font-medium text-slate-600">بدون ورودی</span>
                    ) : (
                      ratioText(rate.rate)
                    )}
                  </span>
                  {spark && rate.status === "ok" ? <Sparkline values={spark} width={80} height={22} /> : null}
                </span>
                <span className="text-[11px] leading-4 text-slate-600">
                  {rate.status === "unavailable"
                    ? "در دسترس نیست"
                    : rate.status === "incomplete"
                      ? `${numberText(rate.denominator)} ${definition.denominator}؛ خریدهای این بازه کامل در آمار ثبت نشده‌اند.`
                      : `${numberText(rate.numerator)} ${definition.numerator} از ${numberText(rate.denominator)} ${definition.denominator}`}
                </span>
                {compare && rate.status === "ok" ? (
                  <Delta change={rate.changePp} kind="points" suffix="نسبت به دوره قبل" />
                ) : null}
                <span className="text-[10px] text-slate-500">{definition.source}</span>
              </dd>
            </div>
          );
        })}
      </dl>
      <PurchaseReconciliation tracking={inputs.tracking ?? null} />
    </section>
  );
}
