"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SalesPage from "../_components/SalesPage";
import ReportDateRangeField from "@/components/SuperAdmin/reports/shared/ReportDateRangeField";
import {
  parseDateOnly,
  toDateOnly,
  useReportQueryState,
} from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import { AdminCard, EmptyState, InlineLoadingState } from "@/components/admin";
import {
  type BehaviorFilters,
  type BehaviorMetadata,
  type BehaviorQuery,
  type BehaviorReportPayload,
  type BehaviorResponse,
  type BehaviorView,
} from "@/types/super-admin/reports/behavior";
import {
  getBehaviorView,
  validateBehaviorQuery,
} from "@/services/super-admin/reports/behavior";
import { faNum } from "@/utils/faNum";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";

const TABS: ReadonlyArray<{ id: BehaviorView; label: string; hint: string }> = [
  { id: "overview", label: "نمای کلی", hint: "بازدید، مسیر و رویداد" },
  { id: "acquisition", label: "جذب و بازاریابی", hint: "کانال، UTM و انتساب" },
  { id: "conversion", label: "تبدیل", hint: "هدف، قیف و فروش قطعی" },
  { id: "content", label: "محصول و محتوا", hint: "صفحه، سفر و محصول" },
  { id: "audience", label: "مخاطبان", hint: "فناوری، جغرافیا و بازگشت" },
  { id: "performance", label: "عملکرد", hint: "Core Web Vitals" },
  { id: "realtime", label: "لحظه‌ای", hint: "کاربران فعال" },
];

const SUMMARY_LABELS: Record<string, string> = {
  pageviews: "بازدید صفحات",
  visitors: "بازدیدکننده یکتا",
  visits: "نشست",
  bounces: "نشست تک‌تعامل",
  totaltime: "زمان حضور کل",
};

const CHANNEL_LABELS: Record<string, string> = {
  direct: "مستقیم",
  llm: "ارجاع ابزارهای هوش مصنوعی",
  paidAds: "تبلیغات پولی",
  organicSearch: "جست‌وجوی ارگانیک",
  paidSearch: "جست‌وجوی پولی",
  organicSocial: "شبکه اجتماعی ارگانیک",
  paidSocial: "شبکه اجتماعی پولی",
  organicShopping: "خرید ارگانیک",
  paidShopping: "خرید پولی",
  organicVideo: "ویدئوی ارگانیک",
  paidVideo: "ویدئوی پولی",
  email: "ایمیل",
  referral: "ارجاع",
};

const EVENT_LABELS: Record<string, string> = {
  view_item: "مشاهده محصول",
  select_item: "انتخاب محصول",
  add_to_cart: "افزودن به سبد",
  remove_from_cart: "حذف از سبد",
  begin_checkout: "شروع پرداخت",
  payment_attempt: "تلاش پرداخت",
  purchase: "خرید موفق",
  refund_irr: "مرجوعی",
  search: "جست‌وجو",
  login: "ورود",
  sign_up: "ثبت‌نام",
};

type Row = Record<string, any>;

function asRecord(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function asRows(value: unknown): Row[] {
  if (Array.isArray(value)) {
    return value.filter((row): row is Row =>
      Boolean(row && typeof row === "object"),
    );
  }
  const record = asRecord(value);
  if (Array.isArray(record.data)) return asRows(record.data);
  return [];
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberText(value: unknown, maximumFractionDigits = 1): string {
  const parsed = finite(value);
  if (parsed === null) return "—";
  return new Intl.NumberFormat("fa-IR", { maximumFractionDigits }).format(
    parsed,
  );
}

function percentText(value: unknown): string {
  const parsed = finite(value);
  return parsed === null ? "—" : `${numberText(parsed, 1)}٪`;
}

function tomanText(value: unknown): string {
  const parsed = finite(value);
  return parsed === null
    ? "—"
    : `${new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 }).format(parsed)} تومان`;
}

function durationText(seconds: unknown): string {
  const parsed = finite(seconds);
  if (parsed === null) return "—";
  const total = Math.max(0, Math.round(parsed));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return minutes
    ? `${faNum(minutes)} دقیقه و ${faNum(remainder)} ثانیه`
    : `${faNum(remainder)} ثانیه`;
}

function dateTime(value?: string | null): string {
  if (!value) return "نامشخص";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })
    : "نامشخص";
}

function translatedLabel(value: unknown): string {
  const label = String(value ?? "").trim() || "نامشخص";
  return CHANNEL_LABELS[label] ?? EVENT_LABELS[label] ?? label;
}

function rowLabel(row: Row): string {
  return translatedLabel(
    row.label ??
      row.name ??
      row.title ??
      row.path ??
      row.urlPath ??
      row.value ??
      row.key,
  );
}

function averageTime(row: Row): number | null {
  const visits = finite(row.visits);
  const total = finite(row.totaltime);
  return visits && total !== null ? total / visits : null;
}

function bounceRate(row: Row): number | null {
  const visits = finite(row.visits);
  const bounces = finite(row.bounces);
  return visits && bounces !== null ? (bounces / visits) * 100 : null;
}

function comparisonChange(current: unknown, previous: unknown): number | null {
  const currentValue = finite(current);
  const previousValue = finite(previous);
  if (currentValue === null || previousValue === null || previousValue === 0)
    return null;
  return ((currentValue - previousValue) / Math.abs(previousValue)) * 100;
}

function ReportBlock({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <AdminCard padded={false}>
      <div className="border-b border-slate-100 px-4 py-3 md:px-5">
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        {description ? (
          <p className="mt-1 text-xs text-slate-500">{description}</p>
        ) : null}
      </div>
      <div className="p-4 md:p-5">{children}</div>
    </AdminCard>
  );
}

function SummaryGrid({
  summary,
  comparison,
}: {
  summary: Row;
  comparison?: Row;
}) {
  const visits = finite(summary.visits);
  const cards = [
    {
      key: "pageviews",
      label: SUMMARY_LABELS.pageviews,
      value: summary.pageviews,
      previous: comparison?.pageviews,
    },
    {
      key: "visitors",
      label: SUMMARY_LABELS.visitors,
      value: summary.visitors,
      previous: comparison?.visitors,
    },
    {
      key: "visits",
      label: SUMMARY_LABELS.visits,
      value: summary.visits,
      previous: comparison?.visits,
    },
    {
      key: "bounceRate",
      label: "نرخ نشست تک‌تعامل",
      value: visits ? (Number(summary.bounces || 0) / visits) * 100 : null,
      previous: finite(comparison?.visits)
        ? (Number(comparison?.bounces || 0) / Number(comparison?.visits)) * 100
        : null,
      format: "percent",
    },
    {
      key: "averageTime",
      label: "میانگین زمان هر نشست",
      value: visits ? Number(summary.totaltime || 0) / visits : null,
      previous: finite(comparison?.visits)
        ? Number(comparison?.totaltime || 0) / Number(comparison?.visits)
        : null,
      format: "duration",
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {cards.map((card) => {
        const change = comparisonChange(card.value, card.previous);
        const display =
          card.format === "percent"
            ? percentText(card.value)
            : card.format === "duration"
              ? durationText(card.value)
              : numberText(card.value, 0);
        return (
          <div
            key={card.key}
            className="rounded-2xl border border-slate-100 bg-gradient-to-b from-white to-slate-50 p-4"
          >
            <p className="text-xs text-slate-500">{card.label}</p>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-infinity-primary">
              {display}
            </p>
            {comparison ? (
              <p
                className={`mt-2 text-xs ${change === null ? "text-slate-400" : change >= 0 ? "text-emerald-700" : "text-rose-700"}`}
              >
                {change === null
                  ? "مقایسه‌پذیر نیست"
                  : `${change >= 0 ? "+" : ""}${percentText(change)} نسبت به دوره قبل`}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function MetricTable({ title, rows }: { title: string; rows: Row[] }) {
  if (!rows.length)
    return <EmptyState title={`${title}: داده‌ای وجود ندارد`} />;
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white">
      <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
        {title}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-right text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">مقدار</th>
              <th className="px-3 py-3 font-medium">بازدید صفحه</th>
              <th className="px-3 py-3 font-medium">بازدیدکننده</th>
              <th className="px-3 py-3 font-medium">نشست</th>
              <th className="px-3 py-3 font-medium">رویداد</th>
              <th className="px-3 py-3 font-medium">نرخ تک‌تعامل</th>
              <th className="px-4 py-3 font-medium">میانگین زمان</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            {rows.slice(0, 30).map((row, index) => (
              <tr
                key={`${rowLabel(row)}-${index}`}
                className="hover:bg-slate-50/70"
              >
                <td
                  className="max-w-[280px] truncate px-4 py-3 font-medium"
                  title={rowLabel(row)}
                >
                  {rowLabel(row)}
                </td>
                <td className="px-3 py-3">{numberText(row.pageviews, 0)}</td>
                <td className="px-3 py-3">{numberText(row.visitors, 0)}</td>
                <td className="px-3 py-3">{numberText(row.visits, 0)}</td>
                <td className="px-3 py-3">{numberText(row.value, 0)}</td>
                <td className="px-3 py-3">{percentText(bounceRate(row))}</td>
                <td className="px-4 py-3">{durationText(averageTime(row))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SimpleTable({
  title,
  rows,
  label,
  value,
}: {
  title: string;
  rows: Row[];
  label?: (row: Row, index: number) => React.ReactNode;
  value?: (row: Row) => React.ReactNode;
}) {
  if (!rows.length)
    return <EmptyState title={`${title}: داده‌ای وجود ندارد`} />;
  const maximum = Math.max(
    ...rows.map((row) => finite(row.value ?? row.count ?? row.visitors) || 0),
    1,
  );
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white">
      <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
        {title}
      </div>
      <div className="divide-y divide-slate-100">
        {rows.slice(0, 30).map((row, index) => {
          const numeric = finite(row.value ?? row.count ?? row.visitors) || 0;
          return (
            <div
              key={`${rowLabel(row)}-${index}`}
              className="relative flex items-center justify-between gap-4 overflow-hidden px-4 py-3 text-xs"
            >
              <div
                className="absolute inset-y-0 right-0 bg-infinity-primary/5"
                style={{
                  width: `${Math.max(0, Math.min(100, (numeric / maximum) * 100))}%`,
                }}
              />
              <span className="relative min-w-0 truncate text-slate-600">
                {label ? label(row, index) : rowLabel(row)}
              </span>
              <span className="relative shrink-0 font-semibold text-slate-800">
                {value ? value(row) : numberText(numeric, 0)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function scalarRows(value: unknown): Row[] {
  const record = asRecord(value);
  return Object.entries(record)
    .filter(([, item]) => finite(item) !== null)
    .map(([label, item]) => ({ label, value: item }));
}

function advancedRows(value: unknown): Row[] {
  const direct = asRows(value);
  if (direct.length) return direct;
  return scalarRows(value);
}

function CommerceCards({
  current,
  previous,
}: {
  current: Row;
  previous?: Row;
}) {
  const values = [
    { key: "paidOrders", label: "سفارش پرداخت‌شده", format: numberText },
    { key: "totalOrders", label: "کل سفارش‌ها", format: numberText },
    { key: "revenueToman", label: "درآمد قطعی", format: tomanText },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {values.map(({ key, label, format }) => {
        const change = comparisonChange(current[key], previous?.[key]);
        return (
          <div
            key={key}
            className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4"
          >
            <p className="text-xs text-emerald-800">{label}</p>
            <p className="mt-2 text-xl font-semibold text-emerald-950">
              {format(current[key], 0)}
            </p>
            {previous ? (
              <p className="mt-2 text-xs text-emerald-700">
                {change === null
                  ? "بدون مبنای مقایسه"
                  : `${change >= 0 ? "+" : ""}${percentText(change)} نسبت به دوره قبل`}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function GoalCard({ value }: { value: unknown }) {
  const goal = asRecord(value);
  const completed = finite(goal.num);
  const total = finite(goal.total);
  if (completed === null && total === null)
    return <EmptyState title="هدف خرید: داده‌ای وجود ندارد" />;
  const rate = total ? ((completed || 0) / total) * 100 : null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="rounded-xl bg-slate-50 p-4">
        <p className="text-xs text-slate-500">نشست‌های تکمیل هدف خرید</p>
        <p className="mt-2 text-xl font-semibold">{numberText(completed, 0)}</p>
      </div>
      <div className="rounded-xl bg-slate-50 p-4">
        <p className="text-xs text-slate-500">نشست‌های واجد شرایط</p>
        <p className="mt-2 text-xl font-semibold">{numberText(total, 0)}</p>
      </div>
      <div className="rounded-xl bg-slate-50 p-4">
        <p className="text-xs text-slate-500">نرخ تکمیل هدف</p>
        <p className="mt-2 text-xl font-semibold">{percentText(rate)}</p>
      </div>
    </div>
  );
}

function FunnelTable({ value }: { value: unknown }) {
  const steps = asRows(value);
  return (
    <SimpleTable
      title="قیف ترتیبی ۲۴ ساعته"
      rows={steps}
      label={(row, index) =>
        `${faNum(index + 1)}. ${translatedLabel(row.value ?? row.label)}`
      }
      value={(row) =>
        `${numberText(row.visitors ?? row.count, 0)} · ریزش ${percentText(row.dropoff)}`
      }
    />
  );
}

function JourneyTable({ value }: { value: unknown }) {
  return (
    <SimpleTable
      title="مسیرهای پرتکرار کاربر"
      rows={asRows(value)}
      label={(row) =>
        [row.e1, row.e2, row.e3, row.e4]
          .filter(Boolean)
          .map(translatedLabel)
          .join(" ← ")
      }
      value={(row) => numberText(row.count, 0)}
    />
  );
}

function RetentionTable({ value }: { value: unknown }) {
  const rows = asRows(value);
  if (!rows.length) return <EmptyState title="نگهداشت: داده‌ای وجود ندارد" />;
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-100">
      <table className="w-full min-w-[620px] text-right text-xs">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            <th className="px-4 py-3">گروه شروع</th>
            <th className="px-4 py-3">روز بعد</th>
            <th className="px-4 py-3">اندازه گروه</th>
            <th className="px-4 py-3">بازگشته</th>
            <th className="px-4 py-3">نگهداشت</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.slice(0, 100).map((row, index) => (
            <tr key={`${row.date}-${row.day}-${index}`}>
              <td className="px-4 py-3">
                {String(row.date ?? "—").slice(0, 10)}
              </td>
              <td className="px-4 py-3">{numberText(row.day, 0)}</td>
              <td className="px-4 py-3">{numberText(row.visitors, 0)}</td>
              <td className="px-4 py-3">{numberText(row.returnVisitors, 0)}</td>
              <td className="px-4 py-3 font-semibold">
                {percentText(row.percentage)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UtmSections({ value }: { value: unknown }) {
  const utm = asRecord(value);
  const definitions = [
    ["utm_source", "منبع UTM"],
    ["utm_medium", "رسانه UTM"],
    ["utm_campaign", "کمپین UTM"],
    ["utm_content", "محتوای UTM"],
    ["utm_term", "عبارت UTM"],
  ] as const;
  const visible = definitions.filter(([key]) => advancedRows(utm[key]).length);
  if (!visible.length) return <EmptyState title="UTM: داده‌ای وجود ندارد" />;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {visible.map(([key, label]) => (
        <SimpleTable key={key} title={label} rows={advancedRows(utm[key])} />
      ))}
    </div>
  );
}

function PerformanceContent({ value }: { value: unknown }) {
  const performance = asRecord(value);
  const summary = asRecord(performance.summary);
  const metrics = ["ttfb", "fcp", "lcp", "cls", "inp"]
    .map((key) => ({
      key,
      label: key.toUpperCase(),
      value:
        summary[key] ??
        summary[`${key}Avg`] ??
        summary[`avg${key.toUpperCase()}`],
    }))
    .filter((item) => finite(item.value) !== null);
  return (
    <div className="space-y-4">
      {metrics.length ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {metrics.map((metric) => (
            <div
              key={metric.key}
              className="rounded-xl border border-slate-100 bg-slate-50 p-4"
            >
              <p className="text-xs font-semibold text-slate-500">
                {metric.label}
              </p>
              <p className="mt-2 text-lg font-semibold">
                {metric.key === "cls"
                  ? numberText(metric.value, 3)
                  : `${numberText(metric.value, 0)} ms`}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="خلاصه Core Web Vitals در دسترس نیست" />
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SimpleTable
          title="صفحات کند یا پرترافیک"
          rows={asRows(performance.pages)}
          value={(row) =>
            `${numberText(row.value ?? row.lcp ?? row.avg, 0)} ms`
          }
        />
        <SimpleTable
          title="عملکرد بر اساس دستگاه"
          rows={asRows(performance.devices)}
          value={(row) =>
            `${numberText(row.value ?? row.lcp ?? row.avg, 0)} ms`
          }
        />
        <SimpleTable
          title="عنوان صفحات"
          rows={asRows(performance.pageTitles)}
          value={(row) =>
            `${numberText(row.value ?? row.lcp ?? row.avg, 0)} ms`
          }
        />
        <SimpleTable
          title="عملکرد مرورگرها"
          rows={asRows(performance.browsers)}
          value={(row) =>
            `${numberText(row.value ?? row.lcp ?? row.avg, 0)} ms`
          }
        />
      </div>
    </div>
  );
}

function ViewContent({ view, data }: { view: BehaviorView; data: Row }) {
  if (view === "realtime") {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-violet-100 bg-gradient-to-l from-violet-50 to-white p-5">
          <p className="text-xs text-violet-700">کاربران فعال اکنون</p>
          <p className="mt-2 text-4xl font-semibold text-violet-950">
            {numberText(data.activeVisitors, 0)}
          </p>
          <p className="mt-2 text-xs text-violet-600">
            هر ۳۰ ثانیه، فقط وقتی این صفحه دیده می‌شود
          </p>
        </div>
        <SimpleTable
          title="صفحات فعال"
          rows={asRows(data.topPages)}
          value={(row) => `${numberText(row.visitors, 0)} کاربر`}
        />
      </div>
    );
  }

  const payload = data as BehaviorReportPayload;
  const sections = asRecord(payload.sections);
  const previous = asRecord(payload.comparison);
  const previousSections = asRecord(previous.sections);
  const summary = asRecord(payload.summary ?? sections.summary);
  const previousSummary = asRecord(
    previous.summary ?? previousSections.summary,
  );

  if (view === "overview") {
    const delivery = asRecord(sections.analyticsDelivery);
    return (
      <div className="space-y-4">
        <SummaryGrid
          summary={summary}
          comparison={payload.comparison ? previousSummary : undefined}
        />
        {Object.keys(delivery).length ? (
          <div
            className={`rounded-xl border px-4 py-3 text-xs ${delivery.status === "healthy" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : delivery.status === "attention" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}
          >
            <p className="font-semibold">
              تحویل رویدادهای قطعی تجارت:{" "}
              {delivery.status === "healthy"
                ? "سالم"
                : delivery.status === "attention"
                  ? "نیازمند رسیدگی"
                  : "در صف"}
            </p>
            <p className="mt-1">
              در انتظار: {numberText(delivery.pending, 0)} · در حال پردازش:{" "}
              {numberText(delivery.processing, 0)} · ناموفق نهایی:{" "}
              {numberText(delivery.deadLetter, 0)}
            </p>
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <MetricTable title="صفحات پربازدید" rows={asRows(sections.path)} />
          <MetricTable
            title="کانال‌های ورودی"
            rows={asRows(sections.channel)}
          />
          <MetricTable
            title="رویدادهای پرتکرار"
            rows={asRows(sections.event)}
          />
        </div>
      </div>
    );
  }
  if (view === "acquisition") {
    return (
      <div className="space-y-4">
        <SummaryGrid
          summary={summary}
          comparison={payload.comparison ? previousSummary : undefined}
        />
        <MetricTable
          title="کانال‌ها — شامل تشخیص ارجاع LLM"
          rows={asRows(sections.channel)}
        />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <MetricTable title="دامنه‌های ارجاع" rows={asRows(sections.domain)} />
          <MetricTable title="منابع ارجاع" rows={asRows(sections.referrer)} />
        </div>
        <ReportBlock
          title="پارامترهای بازاریابی UTM"
          description="منبع، رسانه، کمپین، محتوا و عبارت"
        >
          <UtmSections value={sections.utm} />
        </ReportBlock>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <SimpleTable
            title="انتساب اولین تعامل تا خرید"
            rows={advancedRows(sections.firstAttribution)}
          />
          <SimpleTable
            title="انتساب آخرین تعامل تا خرید"
            rows={advancedRows(sections.lastAttribution)}
          />
        </div>
      </div>
    );
  }
  if (view === "conversion") {
    return (
      <div className="space-y-4">
        <SummaryGrid
          summary={summary}
          comparison={payload.comparison ? previousSummary : undefined}
        />
        <ReportBlock
          title="فروش قطعی Infinity"
          description="منبع مالی: دفتر تجارت؛ درآمد در تومان است و Umami مرجع مالی نیست."
        >
          <CommerceCards
            current={asRecord(sections.commerce)}
            previous={
              payload.comparison
                ? asRecord(previousSections.commerce)
                : undefined
            }
          />
        </ReportBlock>
        <ReportBlock
          title="هدف خرید در Umami"
          description="تعداد نشست‌هایی که رویداد purchase را ثبت کرده‌اند؛ برای رفتار و نسبت‌ها استفاده می‌شود."
        >
          <GoalCard value={sections.purchaseGoal} />
        </ReportBlock>
        <FunnelTable value={sections.checkoutFunnel} />
        <MetricTable title="رویدادهای تبدیل" rows={asRows(sections.event)} />
      </div>
    );
  }
  if (view === "content") {
    const productFilter = asRecord(sections.productFilter);
    return (
      <div className="space-y-4">
        <SummaryGrid
          summary={summary}
          comparison={payload.comparison ? previousSummary : undefined}
        />
        {Object.keys(productFilter).length ? (
          <ReportBlock
            title="نتیجه فیلتر محصول / دسته / تنوع"
            description="فقط رویدادهای دارای شناسه پایدار شمارش می‌شوند."
          >
            <div className="mb-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs text-slate-500">رویداد منطبق</p>
                <p className="mt-2 text-xl font-semibold">
                  {numberText(productFilter.matchedEvents, 0)}
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs text-slate-500">نمونه تحلیل‌شده</p>
                <p className="mt-2 text-xl font-semibold">
                  {numberText(productFilter.sampledEvents, 0)}
                </p>
              </div>
            </div>
            <SimpleTable
              title="مسیرهای مرتبط"
              rows={asRows(productFilter.paths)}
            />
          </ReportBlock>
        ) : null}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <MetricTable title="مسیرها" rows={asRows(sections.path)} />
          <MetricTable title="صفحات ورود" rows={asRows(sections.entry)} />
          <MetricTable title="صفحات خروج" rows={asRows(sections.exit)} />
          <MetricTable
            title="رویدادهای محتوا و محصول"
            rows={asRows(sections.event)}
          />
          <MetricTable title="نسخه و آزمایش" rows={asRows(sections.tag)} />
        </div>
        <JourneyTable value={sections.journeys} />
      </div>
    );
  }
  if (view === "audience") {
    return (
      <div className="space-y-4">
        <SummaryGrid
          summary={summary}
          comparison={payload.comparison ? previousSummary : undefined}
        />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <MetricTable title="دستگاه" rows={asRows(sections.device)} />
          <MetricTable title="مرورگر" rows={asRows(sections.browser)} />
          <MetricTable title="سیستم‌عامل" rows={asRows(sections.os)} />
          <MetricTable title="زبان" rows={asRows(sections.language)} />
          <MetricTable title="کشور" rows={asRows(sections.country)} />
          <MetricTable title="استان / منطقه" rows={asRows(sections.region)} />
          <MetricTable title="شهر" rows={asRows(sections.city)} />
        </div>
        <ReportBlock
          title="نگهداشت و گروه‌های بازگشت"
          description="بازگشت نشست‌ها تا ۳۱ روز پس از اولین حضور در بازه"
        >
          <RetentionTable value={sections.retention} />
        </ReportBlock>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <SummaryGrid
        summary={summary}
        comparison={payload.comparison ? previousSummary : undefined}
      />
      <ReportBlock
        title="Core Web Vitals و عملکرد صفحه"
        description="فقط برای نشست‌هایی که اندازه‌گیری عملکرد در آن‌ها مجاز بوده است."
      >
        <PerformanceContent value={sections.performance} />
      </ReportBlock>
    </div>
  );
}

const FILTER_LABELS: Record<keyof BehaviorFilters, string> = {
  path: "مسیر صفحه",
  referrer: "دامنه ارجاع",
  title: "عنوان صفحه",
  os: "سیستم‌عامل",
  browser: "مرورگر",
  device: "دستگاه",
  country: "کشور",
  region: "استان / منطقه",
  city: "شهر",
  tag: "نسخه یا آزمایش",
  hostname: "دامنه فروشگاه",
  language: "زبان",
  event: "نام رویداد",
  utmSource: "UTM source",
  utmMedium: "UTM medium",
  utmCampaign: "UTM campaign",
  utmContent: "UTM content",
  utmTerm: "UTM term",
  segment: "شناسه Segment",
  cohort: "شناسه Cohort",
  excludeBounce: "حذف نشست تک‌تعامل",
  match: "منطق فیلترها",
  productId: "شناسه محصول",
  categoryId: "شناسه دسته",
  variantId: "شناسه تنوع",
};

const URL_FILTER_KEYS = Object.keys(FILTER_LABELS) as (keyof BehaviorFilters)[];

function filtersFromValues(values: Record<string, string>): BehaviorFilters {
  return Object.fromEntries(
    URL_FILTER_KEYS.flatMap((key) => (values[key] ? [[key, values[key]]] : [])),
  ) as BehaviorFilters;
}

function behaviorViewFromValue(value: string): BehaviorView {
  return TABS.some((tab) => tab.id === value)
    ? (value as BehaviorView)
    : "overview";
}

function fieldsForView(view: BehaviorView): (keyof BehaviorFilters)[] {
  const common: (keyof BehaviorFilters)[] = ["path", "event", "tag"];
  if (view === "acquisition")
    return [
      "referrer",
      "utmSource",
      "utmMedium",
      "utmCampaign",
      "utmContent",
      "utmTerm",
      ...common,
    ];
  if (view === "content")
    return ["productId", "categoryId", "variantId", ...common, "title"];
  if (view === "audience")
    return [
      "device",
      "browser",
      "os",
      "language",
      "country",
      "region",
      "city",
      ...common,
    ];
  if (view === "performance") return ["device", "browser", "path", "tag"];
  if (view === "conversion") return ["event", "path", "tag"];
  return common;
}

function FilterPanel({
  view,
  filters,
  onApply,
}: {
  view: BehaviorView;
  filters: BehaviorFilters;
  onApply: (filters: BehaviorFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [draft, setDraft] = useState(filters);
  useEffect(() => setDraft(filters), [filters]);
  if (view === "realtime") return null;
  const fields = fieldsForView(view);
  const advancedFields: (keyof BehaviorFilters)[] = [
    "segment",
    "cohort",
    "match",
    "excludeBounce",
    "hostname",
  ];
  const validation = validateBehaviorQuery({
    start: "2026-01-01",
    end: "2026-01-01",
    filters: draft,
  });
  const activeCount = Object.values(filters).filter(Boolean).length;
  const renderField = (key: keyof BehaviorFilters) => {
    if (key === "match" || key === "excludeBounce") {
      return (
        <label key={key} className="space-y-1 text-xs text-slate-600">
          <span>{FILTER_LABELS[key]}</span>
          <select
            aria-label={FILTER_LABELS[key]}
            value={draft[key] ?? ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                [key]: event.target.value || undefined,
              }))
            }
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">پیش‌فرض</option>
            {key === "match" ? (
              <>
                <option value="all">همه شرط‌ها</option>
                <option value="any">حداقل یک شرط</option>
              </>
            ) : (
              <>
                <option value="true">بله</option>
                <option value="false">خیر</option>
              </>
            )}
          </select>
          {validation.errors[key] ? (
            <span className="text-rose-600">{validation.errors[key]}</span>
          ) : null}
        </label>
      );
    }
    return (
      <label key={key} className="space-y-1 text-xs text-slate-600">
        <span>{FILTER_LABELS[key]}</span>
        <input
          aria-label={FILTER_LABELS[key]}
          value={String(draft[key] ?? "")}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              [key]: event.target.value || undefined,
            }))
          }
          placeholder={
            key === "path" ? "/plp" : key === "event" ? "view_item" : ""
          }
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm"
          dir="ltr"
        />
        {validation.errors[key] ? (
          <span className="text-rose-600">{validation.errors[key]}</span>
        ) : null}
      </label>
    );
  };
  return (
    <AdminCard padded={false}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-right text-sm font-medium text-slate-700 md:px-5"
      >
        <span>
          فیلترهای گزارش{" "}
          {activeCount ? (
            <span className="mr-2 rounded-full bg-infinity-primary px-2 py-0.5 text-xs text-white">
              {faNum(activeCount)}
            </span>
          ) : null}
        </span>
        <span className="text-xs text-slate-400">
          {open ? "بستن" : "نمایش"}
        </span>
      </button>
      {open ? (
        <div className="space-y-4 border-t border-slate-100 p-4 md:p-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {fields.map(renderField)}
          </div>
          <button
            type="button"
            onClick={() => setAdvanced((value) => !value)}
            className="text-xs font-medium text-infinity-primary hover:underline"
          >
            {advanced
              ? "پنهان کردن فیلترهای پیشرفته"
              : "Segment، Cohort و فیلترهای پیشرفته"}
          </button>
          {advanced ? (
            <div className="grid grid-cols-1 gap-3 rounded-xl bg-slate-50 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {advancedFields.map(renderField)}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!validation.ok}
              onClick={() =>
                onApply(
                  Object.fromEntries(
                    Object.entries(draft).filter(([, value]) => value),
                  ) as BehaviorFilters,
                )
              }
              className="rounded-lg bg-infinity-primary px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
            >
              اعمال فیلترها
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft({});
                onApply({});
              }}
              className="rounded-lg border border-slate-200 px-4 py-2 text-xs text-slate-600"
            >
              پاک کردن
            </button>
          </div>
        </div>
      ) : null}
    </AdminCard>
  );
}

function DateAndComparison({
  start,
  end,
  comparison,
  onRange,
  onComparison,
}: {
  start: string;
  end: string;
  comparison: boolean;
  onRange: (range: { start: string; end: string }) => void;
  onComparison: (enabled: boolean) => void;
}) {
  return (
    <AdminCard padded={false}>
      <div className="flex flex-col gap-4 p-4 md:flex-row md:items-end md:justify-between md:p-5">
        <div className="min-w-0 flex-1">
          <p className="mb-3 text-sm font-medium text-slate-700">
            بازه مشترک گزارش‌ها
          </p>
          <ReportDateRangeField
            start={parseDateOnly(start)}
            end={parseDateOnly(end)}
            onChange={(range) =>
              onRange({
                start: toDateOnly(range.start),
                end: toDateOnly(range.end),
              })
            }
          />
          <p className="mt-2 text-xs text-slate-500">
            منطقه زمانی همه محاسبات: Asia/Tehran
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={comparison}
            onChange={(event) => onComparison(event.target.checked)}
            className="size-4 accent-infinity-primary"
          />
          <span>مقایسه با دوره قبل</span>
        </label>
      </div>
    </AdminCard>
  );
}

function StateNotice({ report }: { report: BehaviorResponse }) {
  if (report.state === "ok") return null;
  const labels = {
    empty: "برای بازه و فیلتر انتخابی داده‌ای ثبت نشده است",
    partial: "بخشی از گزارش در دسترس نیست؛ بخش‌های موجود نمایش داده شده‌اند",
    unavailable: "گزارش رفتار کاربران در دسترس نیست",
  } as const;
  const tones = {
    empty: "border-slate-200 bg-slate-50 text-slate-700",
    partial: "border-amber-200 bg-amber-50 text-amber-800",
    unavailable: "border-rose-200 bg-rose-50 text-rose-800",
  } as const;
  return (
    <div
      className={`rounded-xl border px-4 py-3 text-sm ${tones[report.state]}`}
      role="status"
      data-state={report.state}
    >
      <p className="font-medium">{labels[report.state]}</p>
      {report.error ? (
        <p className="mt-1 text-xs opacity-80">{report.error}</p>
      ) : null}
      {report.metadata.warnings?.map((warning) => (
        <p key={warning} className="mt-1 text-xs opacity-80">
          {warning}
        </p>
      ))}
    </div>
  );
}

function MetadataLine({ metadata }: { metadata: BehaviorMetadata }) {
  return (
    <div
      className="flex flex-wrap gap-x-4 gap-y-1 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-500"
      data-testid="behavior-metadata"
      data-start={metadata.dataStart ?? ""}
      data-stale={String(metadata.cache === "stale")}
    >
      <span>منبع: {metadata.provider ?? "Umami"}</span>
      <span>منطقه زمانی: {metadata.timezone ?? "Asia/Tehran"}</span>
      <span>شروع داده Umami: {metadata.dataStart ?? "نامشخص"}</span>
      <span>بروزرسانی: {dateTime(metadata.refreshedAt)}</span>
      <span>
        کش:{" "}
        {metadata.cache === "stale"
          ? "نسخه پایدار قبلی"
          : metadata.cache === "fresh"
            ? "تازه"
            : "دریافت جدید"}
      </span>
      <span>تعریف: {metadata.definitionVersion ?? "نامشخص"}</span>
    </div>
  );
}

export default function BehaviorReportPage() {
  const { start, end, values, setRange, setValues } = useReportQueryState<
    "view" | "compare" | keyof BehaviorFilters
  >({
    tab: false,
    extraKeys: ["view", "compare", ...URL_FILTER_KEYS],
  });
  const [activeView, setActiveView] = useState<BehaviorView>(() =>
    behaviorViewFromValue(values.view),
  );
  const [comparison, setComparison] = useState(() => values.compare !== "none");
  const [filters, setFilters] = useState<BehaviorFilters>(() =>
    filtersFromValues(values),
  );
  const [report, setReport] = useState<BehaviorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const requested = behaviorViewFromValue(values.view);
    setActiveView((current) => (requested === current ? current : requested));
  }, [values.view]);

  useEffect(() => {
    const requested = filtersFromValues(values);
    setFilters((current) =>
      JSON.stringify(current) === JSON.stringify(requested)
        ? current
        : requested,
    );
  }, [values]);

  useEffect(() => {
    const requested = values.compare !== "none";
    setComparison((current) => (requested === current ? current : requested));
  }, [values.compare]);

  const applyFilters = useCallback(
    (next: BehaviorFilters) => {
      setFilters(next);
      const updates: Record<string, string | null> = { page: "1" };
      for (const key of URL_FILTER_KEYS) updates[key] = next[key] || null;
      void setValues(updates);
    },
    [setValues],
  );

  const query = useMemo<BehaviorQuery>(
    () => ({
      start,
      end,
      comparison:
        activeView !== "realtime" && comparison ? "previous_period" : "none",
      filters,
    }),
    [activeView, comparison, end, filters, start],
  );

  const load = useCallback(
    async (fresh = false) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setRequestError(null);
      try {
        const result = await getBehaviorView(activeView, query, {
          fresh,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setReport(result);
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error as { name?: string })?.name === "AbortError"
        )
          return;
        setReport(null);
        setRequestError(
          getUserFacingErrorMessage(
            error,
            "خطا در بارگذاری گزارش رفتار کاربران",
          ),
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [activeView, query],
  );

  useEffect(() => {
    setReport(null);
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  useEffect(() => {
    if (activeView !== "realtime") return;
    const poll = () => {
      if (!document.hidden) void load(true);
    };
    const onVisibility = () => {
      if (!document.hidden) poll();
    };
    const interval = window.setInterval(poll, 30_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeView, load]);

  return (
    <SalesPage
      title="رفتار کاربران"
      description="مرکز یکپارچه رفتار، جذب، تبدیل، محتوا، مخاطب و عملکرد فروشگاه"
      actions={
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          className="rounded-lg bg-infinity-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {loading ? "در حال بارگذاری…" : "بروزرسانی"}
        </button>
      }
    >
      <div className="space-y-4" dir="rtl">
        <DateAndComparison
          start={start}
          end={end}
          comparison={comparison}
          onRange={setRange}
          onComparison={(enabled) => {
            setComparison(enabled);
            void setValues({ compare: enabled ? "previous_period" : "none" });
          }}
        />
        <div
          className="grid grid-cols-2 gap-2 rounded-2xl border border-slate-100 bg-white p-2 md:grid-cols-4 xl:grid-cols-7"
          role="tablist"
          aria-label="نماهای رفتار کاربران"
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeView === tab.id}
              onClick={() => {
                setActiveView(tab.id);
                void setValues({ view: tab.id, page: "1" });
              }}
              className={`rounded-xl px-3 py-3 text-right transition ${activeView === tab.id ? "bg-infinity-primary text-white shadow-sm" : "text-slate-600 hover:bg-slate-50"}`}
            >
              <span className="block text-sm font-medium">{tab.label}</span>
              <span
                className={`mt-1 block text-[10px] ${activeView === tab.id ? "text-white/75" : "text-slate-400"}`}
              >
                {tab.hint}
              </span>
            </button>
          ))}
        </div>
        <FilterPanel
          view={activeView}
          filters={filters}
          onApply={applyFilters}
        />
        {requestError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {requestError}
          </div>
        ) : null}
        {loading && !report ? (
          <InlineLoadingState label="در حال دریافت گزارش رفتار کاربران…" />
        ) : null}
        {report ? <StateNotice report={report} /> : null}
        {report &&
        report.state !== "unavailable" &&
        report.state !== "empty" &&
        report.data ? (
          <ViewContent view={activeView} data={asRecord(report.data)} />
        ) : null}
        {report?.state === "empty" ? (
          <EmptyState title="بازه یا فیلتر انتخابی داده‌ای ندارد" />
        ) : null}
        {report ? <MetadataLine metadata={report.metadata} /> : null}
      </div>
    </SalesPage>
  );
}

export { TABS };
