"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { BehaviorResponse, PurchaseTracking } from "@/types/super-admin/reports/behavior";
import { dateText, dateTimeText, numberText } from "../format";
import { presentAnalyticsMessage } from "../presentation";
import { PurchaseReconciliation } from "./ConversionRates";

type Source = { label: string; report: BehaviorResponse | null; requestError: string | null };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const STATE_TEXT: Record<BehaviorResponse["state"], string> = {
  ok: "کامل",
  empty: "بدون داده در این بازه",
  partial: "ناقص",
  unavailable: "در دسترس نیست",
};

const CAPABILITIES: ReadonlyArray<{ label: string; supported: boolean; note: string }> = [
  { label: "آمار، روند و تفکیک بازدید", supported: true, note: "" },
  { label: "قیف مرتب و هدف خرید", supported: true, note: "شمارش بر پایه نشست" },
  { label: "انتساب اولین و آخرین منبع", supported: true, note: "۲۰ منبع برتر در هر بُعد" },
  { label: "مسیرهای واقعی", supported: true, note: "حداکثر ۴ گام در هر بازدید" },
  { label: "بازگشت بازدیدکنندگان و سرعت صفحه", supported: true, note: "" },
  { label: "زمان تا تبدیل", supported: false, note: "قیف Umami 3.3.1 زمان مراحل را برنمی‌گرداند" },
  { label: "یادداشت روی نمودارها", supported: false, note: "از Umami 3.4" },
  { label: "ضبط جلسه و نقشه حرارتی", supported: false, note: "در این فروشگاه خاموش است" },
];

/**
 * Freshness, partial failures, delivery of server events and the purchase
 * reconciliation, folded away at the bottom: important for trusting the
 * numbers above, not for reading them.
 */
export default function DataHealthPanel({
  sources,
  delivery,
  tracking,
}: {
  sources: Source[];
  delivery: Record<string, unknown> | null;
  tracking: PurchaseTracking | null;
}) {
  const reports = sources.filter((source) => source.report || source.requestError);
  const metadata = reports.find((source) => source.report)?.report?.metadata;
  const problems = reports.filter(
    (source) =>
      source.requestError ||
      source.report?.state === "partial" ||
      source.report?.state === "unavailable" ||
      source.report?.metadata.cache === "stale",
  );
  const trackingProblem = tracking?.status === "not_live" || tracking?.status === "degraded";
  const deliveryProblem = delivery?.status === "attention";
  const healthy = !problems.length && !trackingProblem && !deliveryProblem;
  const Icon = healthy ? CheckCircle2 : AlertTriangle;

  return (
    <details className="group rounded-prominent border border-slate-100 bg-white shadow-sm" data-testid="behavior-metadata" data-start={metadata?.dataStart ?? ""} data-stale={String(metadata?.cache === "stale")}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 p-4 text-sm md:px-5">
        <span className="flex items-center gap-2 font-medium text-slate-900">
          <Icon aria-hidden className={healthy ? "size-4 text-emerald-700" : "size-4 text-amber-700"} />
          کیفیت داده و اتصال: {healthy ? "سالم" : "نیازمند توجه"}
        </span>
        <span className="text-xs text-slate-600">
          آمار از {dateText(metadata?.dataStart?.slice(0, 10))} · به وقت تهران ·{" "}
          <span className="group-open:hidden">نمایش جزئیات</span>
          <span className="hidden group-open:inline">بستن</span>
        </span>
      </summary>
      <div className="grid gap-6 border-t border-slate-100 p-4 text-xs text-slate-700 md:px-5 lg:grid-cols-3">
        <section className="space-y-2">
          <h4 className="font-semibold text-slate-900">وضعیت بخش‌ها</h4>
          <ul className="space-y-1.5">
            {reports.map((source) => (
              <li key={source.label}>
                <span className="font-medium">{source.label}:</span>{" "}
                {source.requestError
                  ? presentAnalyticsMessage(source.requestError)
                  : source.report
                    ? STATE_TEXT[source.report.state]
                    : "—"}
                {source.report?.metadata.cache === "stale" ? " · آخرین نسخه سالم" : ""}
                {source.report ? ` · ${dateTimeText(source.report.metadata.refreshedAt)}` : ""}
                {Array.from(
                  new Set((source.report?.metadata.warnings ?? []).map(presentAnalyticsMessage)),
                ).map((warning) => (
                  <span key={warning} className="block text-[11px] text-amber-800">
                    {warning}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </section>
        <section className="space-y-2">
          <h4 className="font-semibold text-slate-900">ثبت خرید و ارسال رخدادهای سرور</h4>
          <PurchaseReconciliation tracking={tracking} />
          {delivery ? (
            <p>
              ارسال پرداخت‌های تأییدشده و مرجوعی‌ها از سرور به آمار:{" "}
              <strong className="font-medium">
                {delivery.status === "healthy"
                  ? "سالم"
                  : delivery.status === "attention"
                    ? "نیازمند رسیدگی"
                    : "در انتظار ثبت"}
              </strong>
              <span className="block text-[11px] text-slate-600">
                منتظر: {numberText(delivery.pending)} · در حال ثبت: {numberText(delivery.processing)} ·
                نیازمند بررسی: {numberText(delivery.deadLetter)}
              </span>
            </p>
          ) : null}
        </section>
        <section className="space-y-2">
          <h4 className="font-semibold text-slate-900">
            امکانات{" "}
            <span className="font-normal text-slate-600" dir="ltr">
              Umami {metadata?.providerContractVersion ?? "3.3.1"}
            </span>
          </h4>
          <p className="text-[11px] text-slate-600">
            نسخه‌ای که گزارش برای آن ساخته شده؛ Umami نسخه خود را از طریق API اعلام نمی‌کند.
          </p>
          <ul className="space-y-1">
            {CAPABILITIES.map((capability) => (
              <li key={capability.label} className="flex items-start gap-1.5">
                <span aria-hidden className={capability.supported ? "text-emerald-700" : "text-slate-500"}>
                  {capability.supported ? "✓" : "–"}
                </span>
                <span>
                  {capability.label}
                  <span className="sr-only">{capability.supported ? " (پشتیبانی می‌شود)" : " (پشتیبانی نمی‌شود)"}</span>
                  {capability.note ? <span className="text-[11px] text-slate-600"> · {capability.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-slate-600" dir="ltr">
            {record(metadata).definitionVersion ? `definition: ${String(record(metadata).definitionVersion)}` : null}
          </p>
        </section>
      </div>
    </details>
  );
}
