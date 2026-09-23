"use client";

import {
  type ComponentType,
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Cpu,
  Gamepad2,
  Globe2,
  Laptop,
  Monitor,
  MonitorSmartphone,
  Smartphone,
  Tablet,
  Tv,
  Watch,
} from "lucide-react";
import {
  FaChrome,
  FaEdge,
  FaFirefoxBrowser,
  FaOpera,
  FaSafari,
  FaWindows,
} from "react-icons/fa";
import { SiAndroid, SiApple, SiLinux } from "react-icons/si";
import SalesPage from "../_components/SalesPage";
import ReportDateRangeField from "@/components/SuperAdmin/reports/shared/ReportDateRangeField";
import JourneyFlow from "@/components/SuperAdmin/reports/shared/JourneyFlow";
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
import {
  type BehaviorDimension,
  CHECKOUT_EVENT_NAMES,
  FILTERABLE_EVENTS,
  measuredPerformanceRows,
  performanceP75,
  presentAnalyticsMessage,
  presentBehaviorValue,
  presentJourneyStep,
  presentWindow,
} from "./presentation";

const TABS: ReadonlyArray<{ id: BehaviorView; label: string; hint: string }> = [
  { id: "overview", label: "خلاصه بازدیدها", hint: "آمار اصلی و صفحات محبوب" },
  { id: "acquisition", label: "ورودی‌ها و تبلیغات", hint: "کاربران از کجا آمده‌اند" },
  { id: "conversion", label: "مسیر خرید", hint: "از مشاهده محصول تا خرید" },
  { id: "content", label: "صفحات و محصولات", hint: "محتوای محبوب و مسیر حرکت" },
  { id: "audience", label: "شناخت کاربران", hint: "مکان، دستگاه و بازگشت" },
  { id: "performance", label: "سرعت و تجربه کاربری", hint: "سرعت بارگذاری و پاسخ صفحه" },
  { id: "realtime", label: "اکنون در سایت", hint: "کاربران و صفحات فعال" },
];

const SUMMARY_LABELS: Record<string, string> = {
  pageviews: "نمایش صفحه",
  visitors: "بازدیدکننده یکتا",
  visits: "بازدید",
  bounces: "بازدید تک‌صفحه‌ای",
  totaltime: "زمان حضور کل",
};

type Row = Record<string, unknown>;

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

function rawRowLabel(row: Row): unknown {
  return (
    row.label ??
    row.name ??
    row.title ??
    row.path ??
    row.urlPath ??
    row.value ??
    row.key
  );
}

function rowLabel(row: Row, dimension: BehaviorDimension = "generic"): string {
  return presentBehaviorValue(rawRowLabel(row), dimension);
}

type ReportIcon = ComponentType<{
  "aria-hidden"?: boolean;
  className?: string;
  focusable?: boolean;
}>;

const DEVICE_ICONS: Record<string, ReportIcon> = {
  desktop: Monitor,
  laptop: Laptop,
  mobile: Smartphone,
  phone: Smartphone,
  tablet: Tablet,
  smarttv: Tv,
  console: Gamepad2,
  wearable: Watch,
};

const BROWSER_ICONS: Record<string, ReportIcon> = {
  chrome: FaChrome,
  chromium: FaChrome,
  edge: FaEdge,
  firefox: FaFirefoxBrowser,
  opera: FaOpera,
  safari: FaSafari,
};

const OS_ICONS: Record<string, ReportIcon> = {
  android: SiAndroid,
  ios: SiApple,
  ipados: SiApple,
  linux: SiLinux,
  macos: SiApple,
  macosx: SiApple,
  windows: FaWindows,
  chromeos: FaChrome,
};

function normalizedMachineValue(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[-_\s]/g, "");
}

function iconForValue(
  value: unknown,
  dimension: BehaviorDimension,
): ReportIcon | null {
  const key = normalizedMachineValue(value);
  if (dimension === "device") return DEVICE_ICONS[key] ?? MonitorSmartphone;
  if (dimension === "browser") return BROWSER_ICONS[key] ?? Globe2;
  if (dimension === "os") return OS_ICONS[key] ?? Cpu;
  if (dimension === "country" || dimension === "region" || dimension === "city") {
    return Globe2;
  }
  return null;
}

function DimensionLabel({
  value,
  dimension = "generic",
}: {
  value: unknown;
  dimension?: BehaviorDimension;
}) {
  const Icon = iconForValue(value, dimension);
  const label = presentBehaviorValue(value, dimension);
  return (
    <span className="flex min-w-0 items-center gap-2">
      {Icon ? (
        <span
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500"
          data-dimension-icon={dimension}
        >
          {createElement(Icon, {
            "aria-hidden": true,
            className: "size-4",
            focusable: false,
          })}
        </span>
      ) : null}
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
    </span>
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
      hint: "هر بار که یکی از صفحه‌های فروشگاه باز شده است",
      value: summary.pageviews,
      previous: comparison?.pageviews,
    },
    {
      key: "visitors",
      label: SUMMARY_LABELS.visitors,
      hint: "تعداد تقریبی افراد جداگانه در این بازه",
      value: summary.visitors,
      previous: comparison?.visitors,
    },
    {
      key: "visits",
      label: SUMMARY_LABELS.visits,
      hint: "هر بار ورود و فعالیت یک کاربر در فروشگاه",
      value: summary.visits,
      previous: comparison?.visits,
    },
    {
      key: "bounceRate",
      label: "نرخ پرش",
      hint: "درصد بازدیدهایی که پس از دیدن یک صفحه تمام شده‌اند",
      value: visits ? (Number(summary.bounces || 0) / visits) * 100 : null,
      previous: finite(comparison?.visits)
        ? (Number(comparison?.bounces || 0) / Number(comparison?.visits)) * 100
        : null,
      format: "percent",
      lowerIsBetter: true,
    },
    {
      key: "averageTime",
      label: "میانگین زمان حضور",
      hint: "میانگین زمان فعالیت در هر بازدید",
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
            className="rounded-2xl border border-slate-100 bg-gradient-to-b from-white to-slate-50 p-4 shadow-[0_1px_0_rgba(15,23,42,0.02)]"
          >
            <p className="text-xs font-medium text-slate-600">{card.label}</p>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-infinity-primary">
              {display}
            </p>
            <p className="mt-2 min-h-8 text-[11px] leading-4 text-slate-400">
              {card.hint}
            </p>
            {comparison ? (
              <p
                className={`mt-2 border-t border-slate-100 pt-2 text-[11px] ${
                  change === null
                    ? "text-slate-400"
                    : (card.lowerIsBetter ? change <= 0 : change >= 0)
                      ? "text-emerald-700"
                      : "text-rose-700"
                }`}
              >
                {change === null
                  ? "داده کافی برای مقایسه وجود ندارد"
                  : `${change >= 0 ? "+" : ""}${percentText(change)} نسبت به دوره قبل`}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function CompactEmptyState({ title }: { title: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-5 text-center">
      <p className="text-sm font-medium text-slate-600">هنوز داده‌ای ثبت نشده است</p>
      <p className="mt-1 text-xs text-slate-400">{title}</p>
    </div>
  );
}

const DIMENSION_HEADINGS: Partial<Record<BehaviorDimension, string>> = {
  path: "صفحه",
  channel: "منبع ورود",
  event: "اقدام کاربر",
  domain: "سایت ارجاع‌دهنده",
  referrer: "منبع ورود",
  device: "نوع دستگاه",
  browser: "مرورگر",
  os: "سیستم‌عامل",
  language: "زبان",
  country: "کشور",
  region: "استان",
  city: "شهر",
  tag: "نسخه یا آزمایش",
};

const VISIBLE_ROWS = 30;

function primaryRowValue(row: Row): number {
  return (
    finite(row.pageviews) ??
    finite(row.count) ??
    finite(row.visitors) ??
    finite(row.visits) ??
    finite(row.value) ??
    0
  );
}

/** «۳۰ مورد از ۱۰۰» when the table shows only the top rows. */
function rowCountText(total: number): string {
  return total > VISIBLE_ROWS
    ? `${faNum(VISIBLE_ROWS)} مورد برتر از ${faNum(total)}`
    : `${faNum(total)} مورد`;
}

function MetricTable({
  title,
  rows,
  dimension = "generic",
}: {
  title: string;
  rows: Row[];
  dimension?: BehaviorDimension;
}) {
  if (!rows.length) return <CompactEmptyState title={`برای «${title}»`} />;
  const metricColumns = [
    {
      key: "pageviews",
      label: "نمایش صفحه",
      available: rows.some((row) => finite(row.pageviews) !== null),
      render: (row: Row) => numberText(row.pageviews, 0),
    },
    {
      key: "visitors",
      label: "بازدیدکننده",
      available: rows.some((row) => finite(row.visitors) !== null),
      render: (row: Row) => numberText(row.visitors, 0),
    },
    {
      key: "visits",
      label: "بازدید",
      available: rows.some((row) => finite(row.visits) !== null),
      render: (row: Row) => numberText(row.visits, 0),
    },
    {
      key: "count",
      label: dimension === "event" ? "تعداد رخداد" : "تعداد",
      available: rows.some((row) => finite(row.count) !== null),
      render: (row: Row) => numberText(row.count, 0),
    },
    {
      key: "value",
      label: "تعداد",
      available:
        !rows.some((row) => finite(row.count) !== null) &&
        rows.some((row) => finite(row.value) !== null),
      render: (row: Row) => numberText(row.value, 0),
    },
    {
      key: "bounceRate",
      label: "نرخ پرش",
      available: rows.some((row) => bounceRate(row) !== null),
      render: (row: Row) => percentText(bounceRate(row)),
    },
    {
      key: "averageTime",
      label: "میانگین حضور",
      available: rows.some((row) => averageTime(row) !== null),
      render: (row: Row) => durationText(averageTime(row)),
    },
  ].filter((column) => column.available);
  const maximum = Math.max(...rows.map(primaryRowValue), 1);
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        <span className="text-[11px] text-slate-400">{rowCountText(rows.length)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-right text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="min-w-[220px] px-4 py-3 font-medium">
                {DIMENSION_HEADINGS[dimension] ?? "عنوان"}
              </th>
              {metricColumns.map((column) => (
                <th key={column.key} className="whitespace-nowrap px-3 py-3 font-medium">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            {rows.slice(0, VISIBLE_ROWS).map((row, index) => {
              const width = Math.max(0, Math.min(100, (primaryRowValue(row) / maximum) * 100));
              return (
                <tr
                  key={`${rowLabel(row, dimension)}-${index}`}
                  className="group hover:bg-slate-50/70"
                >
                  <td className="relative max-w-[320px] overflow-hidden px-4 py-2.5 font-medium">
                    <span
                      aria-hidden
                      className="absolute inset-y-1 right-1 rounded-md bg-infinity-primary/[0.045]"
                      style={{ width: `${width}%` }}
                    />
                    <span className="relative">
                      <DimensionLabel value={rawRowLabel(row)} dimension={dimension} />
                    </span>
                  </td>
                  {metricColumns.map((column) => (
                    <td key={column.key} className="whitespace-nowrap px-3 py-3 tabular-nums">
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
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
  numericValue,
  dimension = "generic",
}: {
  title: string;
  rows: Row[];
  label?: (row: Row, index: number) => React.ReactNode;
  value?: (row: Row) => React.ReactNode;
  numericValue?: (row: Row) => number | null;
  dimension?: BehaviorDimension;
}) {
  if (!rows.length) return <CompactEmptyState title={`برای «${title}»`} />;
  const metricValue = (row: Row) =>
    numericValue?.(row) ?? finite(row.value ?? row.count ?? row.visitors) ?? 0;
  const maximum = Math.max(
    ...rows.map(metricValue),
    1,
  );
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        <span className="text-[11px] text-slate-400">{rowCountText(rows.length)}</span>
      </div>
      <div className="divide-y divide-slate-100">
        {rows.slice(0, VISIBLE_ROWS).map((row, index) => {
          const numeric = metricValue(row);
          return (
            <div
              key={`${rowLabel(row, dimension)}-${index}`}
              className="relative flex min-h-12 items-center justify-between gap-4 overflow-hidden px-4 py-2.5 text-xs"
            >
              <div
                aria-hidden
                className="absolute inset-y-1 right-1 rounded-md bg-infinity-primary/[0.055]"
                style={{
                  width: `${Math.max(0, Math.min(100, (numeric / maximum) * 100))}%`,
                }}
              />
              <span className="relative min-w-0 text-slate-600">
                {label ? (
                  label(row, index)
                ) : (
                  <DimensionLabel value={rawRowLabel(row)} dimension={dimension} />
                )}
              </span>
              <span className="relative shrink-0 whitespace-nowrap font-semibold tabular-nums text-slate-800">
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

function dateOnlyText(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T12:00:00+03:30`).toLocaleDateString("fa-IR", {
    timeZone: "Asia/Tehran",
  });
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
    { key: "totalOrders", label: "کل سفارش‌های ثبت‌شده", format: numberText },
    { key: "revenueToman", label: "درآمد خالص پرداخت‌شده", format: tomanText },
  ];
  const range = asRecord(current.range);
  const start = dateOnlyText(range.start);
  const end = dateOnlyText(range.end);
  return (
    <div className="space-y-3">
    {start && end ? (
      <p className="text-xs text-slate-500">
        سفارش‌های فروشگاه جدید از {start} تا {end}؛ سفارش‌های واردشده از سایت قدیم در این عددها نیستند.
      </p>
    ) : null}
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
        <p className="text-xs text-slate-500">بازدیدکنندگانی که خرید کرده‌اند</p>
        <p className="mt-2 text-xl font-semibold">{numberText(completed, 0)}</p>
      </div>
      <div className="rounded-xl bg-slate-50 p-4">
        <p className="text-xs text-slate-500">همه بازدیدکنندگان</p>
        <p className="mt-2 text-xl font-semibold">{numberText(total, 0)}</p>
      </div>
      <div className="rounded-xl bg-slate-50 p-4">
        <p className="text-xs text-slate-500">نرخ تبدیل بازدیدکننده به خریدار</p>
        <p className="mt-2 text-xl font-semibold">{percentText(rate)}</p>
      </div>
    </div>
  );
}

function funnelStepCount(row: Row): number {
  return (
    finite(row.visitors) ??
    finite(row.count) ??
    finite(row.num) ??
    finite(row.total) ??
    0
  );
}

function FunnelVisualization({
  value,
  title,
  windowMinutes,
}: {
  value: unknown;
  title: string;
  windowMinutes?: unknown;
}) {
  const steps = asRows(value);
  if (!steps.length) return <CompactEmptyState title={`برای «${title}»`} />;
  const windowText = presentWindow(windowMinutes);
  const firstCount = Math.max(funnelStepCount(steps[0]), 1);
  const lastCount = funnelStepCount(steps[steps.length - 1]);
  const overallRate = (lastCount / firstCount) * 100;

  let biggestDropoff: { label: string; count: number; rate: number | null } | null = null;
  for (let index = 1; index < steps.length; index += 1) {
    const count = funnelStepCount(steps[index]);
    const previousCount = funnelStepCount(steps[index - 1]);
    const dropoffCount = Math.max(0, previousCount - count);
    if (dropoffCount <= 0) continue;
    if (!biggestDropoff || dropoffCount > biggestDropoff.count) {
      biggestDropoff = {
        label: presentBehaviorValue(steps[index].value ?? steps[index].label ?? steps[index].name, "event"),
        count: dropoffCount,
        rate: previousCount ? (dropoffCount / previousCount) * 100 : null,
      };
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white">
      <div className="flex flex-col gap-2 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          <p className="mt-1 text-xs text-slate-500">
            {windowText
              ? `هر مرحله باید حداکثر ${windowText} پس از مرحله قبل، در همان نشست، انجام شده باشد.`
              : "مراحل به ترتیب و در همان نشست شمرده می‌شوند."}
          </p>
        </div>
        <div className="shrink-0 rounded-xl bg-infinity-primary/5 px-3 py-2 text-xs text-slate-600">
          تبدیل از ابتدا تا انتها: <strong className="text-infinity-primary">{percentText(overallRate)}</strong>
        </div>
      </div>
      {biggestDropoff ? (
        <p className="border-b border-slate-100 bg-rose-50/60 px-4 py-2.5 text-xs text-rose-800 md:px-5">
          بیشترین ریزش در مرحله «{biggestDropoff.label}» بوده است؛{" "}
          {numberText(biggestDropoff.count, 0)} بازدیدکننده ({percentText(biggestDropoff.rate)}) ادامه نداده‌اند.
        </p>
      ) : null}
      <ol className="space-y-3 p-4 md:p-5" aria-label={`مراحل ${title}`}>
        {steps.map((row, index) => {
          const count = funnelStepCount(row);
          const previousCount = index ? funnelStepCount(steps[index - 1]) : count;
          const dropoffCount = Math.max(0, previousCount - count);
          const retainedRate = previousCount ? (count / previousCount) * 100 : null;
          const dropoffRate = previousCount ? (dropoffCount / previousCount) * 100 : null;
          const overallWidth = Math.max(0, Math.min(100, (count / firstCount) * 100));
          // True proportion; a hairline keeps a tiny non-zero step visible.
          const visibleWidth = count > 0 ? Math.max(1, overallWidth) : 0;
          const label = presentBehaviorValue(row.value ?? row.label ?? row.name, "event");
          return (
            <li key={`${label}-${index}`} className="grid gap-2 md:grid-cols-[minmax(150px,0.8fr)_minmax(280px,2fr)] md:items-center">
              <div className="flex items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-full border border-infinity-primary/15 bg-infinity-primary/5 text-xs font-semibold text-infinity-primary">
                  {faNum(index + 1)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-700">{label}</p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {numberText(count, 0)} بازدیدکننده
                  </p>
                </div>
              </div>
              <div>
                <div className="relative h-10 overflow-hidden rounded-xl bg-slate-100">
                  <div
                    aria-hidden
                    className="absolute inset-y-0 right-0 rounded-xl bg-gradient-to-l from-infinity-primary to-violet-500"
                    style={{ width: `${visibleWidth}%` }}
                  />
                  <div className="relative flex h-full items-center justify-between gap-3 px-3 text-xs">
                    <strong className={visibleWidth >= 35 ? "text-white" : "text-slate-700"}>
                      {numberText(count, 0)}
                    </strong>
                    <span className="rounded-md bg-white/90 px-2 py-1 text-slate-600 shadow-sm">
                      {index === 0
                        ? "شروع مسیر"
                        : `${percentText(retainedRate)} از مرحله قبل`}
                    </span>
                  </div>
                </div>
                {index > 0 ? (
                  <p className="mt-1.5 text-[11px] text-rose-700">
                    ریزش این مرحله: {numberText(dropoffCount, 0)} بازدیدکننده ({percentText(dropoffRate)})
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function RetentionTable({ value }: { value: unknown }) {
  const rows = asRows(value);
  if (!rows.length) return <CompactEmptyState title="برای بازگشت کاربران" />;
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-100">
      <table className="w-full min-w-[620px] text-right text-xs">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            <th className="px-4 py-3">تاریخ اولین بازدید</th>
            <th className="px-4 py-3">چند روز بعد</th>
            <th className="px-4 py-3">کاربران این گروه</th>
            <th className="px-4 py-3">کاربران بازگشته</th>
            <th className="px-4 py-3">درصد بازگشت</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.slice(0, 100).map((row, index) => (
            <tr key={`${row.date}-${row.day}-${index}`}>
              <td className="px-4 py-3">
                {dateOnlyText(String(row.date ?? "").slice(0, 10)) ?? "—"}
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

const ATTRIBUTION_GROUPS = [
  ["referrer", "سایت ارجاع‌دهنده", "domain"],
  ["paidAds", "تبلیغات کلیکی", "generic"],
  ["utm_source", "منبع تبلیغ", "generic"],
  ["utm_medium", "روش انتشار", "generic"],
  ["utm_campaign", "نام کمپین", "generic"],
] as const;

/**
 * Umami attribution: for sessions that reached `purchase`, the first or last
 * source seen in that session, one table per source dimension.
 */
function AttributionGroups({ value, title }: { value: unknown; title: string }) {
  const groups = asRecord(value);
  const visible = ATTRIBUTION_GROUPS.filter(([key]) => asRows(groups[key]).length);
  if (!visible.length) {
    return (
      <CompactEmptyState title={`برای «${title}»؛ خریدها از نسخه جدید آمار به مسیر بازدیدکننده متصل می‌شوند`} />
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {visible.map(([key, label, dimension]) => (
        <SimpleTable
          key={key}
          title={`${title}: ${label}`}
          rows={asRows(groups[key])}
          dimension={dimension}
          value={(row) => `${numberText(row.value, 0)} خریدار`}
        />
      ))}
    </div>
  );
}

function UtmSections({ value }: { value: unknown }) {
  const utm = asRecord(value);
  const definitions = [
    ["utm_source", "منبع تبلیغ"],
    ["utm_medium", "روش انتشار"],
    ["utm_campaign", "نام کمپین"],
    ["utm_content", "نسخه محتوای تبلیغ"],
    ["utm_term", "عبارت تبلیغاتی"],
  ] as const;
  const visible = definitions.filter(([key]) => advancedRows(utm[key]).length);
  if (!visible.length) return <CompactEmptyState title="برای کمپین‌های تبلیغاتی" />;
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
  const metricDefinitions = [
    { key: "lcp", label: "LCP", description: "نمایش محتوای اصلی صفحه" },
    { key: "inp", label: "INP", description: "واکنش صفحه به کلیک و لمس" },
    { key: "cls", label: "CLS", description: "جابه‌جایی ناگهانی اجزای صفحه" },
    { key: "fcp", label: "FCP", description: "نمایش نخستین محتوای صفحه" },
    { key: "ttfb", label: "TTFB", description: "دریافت نخستین پاسخ از سرور" },
  ] as const;
  const metrics = metricDefinitions
    .map((metric) => ({
      ...metric,
      value: performanceP75(
        summary[metric.key] ??
          summary[`${metric.key}Avg`] ??
          summary[`avg${metric.key.toUpperCase()}`],
      ),
    }))
    .filter((item) => item.value !== null);
  const pageRows = measuredPerformanceRows(performance.pages);
  const deviceRows = measuredPerformanceRows(performance.devices);
  const titleRows = measuredPerformanceRows(performance.pageTitles);
  const browserRows = measuredPerformanceRows(performance.browsers);
  const performanceValue = (row: Row) => performanceP75(row);
  const renderPerformanceValue = (row: Row) => (
    <span>
      {numberText(performanceP75(row), 0)} میلی‌ثانیه
      {finite(row.count) !== null ? (
        <span className="mr-1 font-normal text-slate-400">
          · {numberText(row.count, 0)} سنجش
        </span>
      ) : null}
    </span>
  );
  return (
    <div className="space-y-4">
      {metrics.length ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {metrics.map((metric) => (
            <div
              key={metric.key}
              className="rounded-xl border border-slate-100 bg-gradient-to-b from-white to-slate-50 p-4"
            >
              <p className="text-xs font-semibold text-slate-600">
                {metric.label}
              </p>
              <p className="mt-2 text-xl font-semibold text-slate-900">
                {metric.key === "cls"
                  ? numberText(metric.value, 3)
                  : `${numberText(metric.value, 0)} میلی‌ثانیه`}
              </p>
              <p className="mt-2 text-[11px] leading-4 text-slate-400">
                {metric.description}؛ ۷۵٪ بازدیدها سریع‌تر از این مقدار بوده‌اند
              </p>
            </div>
          ))}
        </div>
      ) : (
        <CompactEmptyState title="برای خلاصه سرعت صفحه" />
      )}
      {pageRows.length || deviceRows.length || titleRows.length || browserRows.length ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {pageRows.length ? (
            <SimpleTable
              title="نمایش محتوای اصلی (LCP) در صفحه‌ها"
              rows={pageRows}
              dimension="path"
              numericValue={performanceValue}
              value={renderPerformanceValue}
            />
          ) : null}
          {deviceRows.length ? (
            <SimpleTable
              title="نمایش محتوای اصلی (LCP) بر اساس دستگاه"
              rows={deviceRows}
              dimension="device"
              numericValue={performanceValue}
              value={renderPerformanceValue}
            />
          ) : null}
          {titleRows.length ? (
            <SimpleTable
              title="نمایش محتوای اصلی (LCP) بر اساس عنوان صفحه"
              rows={titleRows}
              numericValue={performanceValue}
              value={renderPerformanceValue}
            />
          ) : null}
          {browserRows.length ? (
            <SimpleTable
              title="نمایش محتوای اصلی (LCP) بر اساس مرورگر"
              rows={browserRows}
              dimension="browser"
              numericValue={performanceValue}
              value={renderPerformanceValue}
            />
          ) : null}
        </div>
      ) : (
        <CompactEmptyState title="برای جزئیات سرعت صفحه‌ها و دستگاه‌ها" />
      )}
    </div>
  );
}

function ViewContent({ view, data }: { view: BehaviorView; data: Row }) {
  if (view === "realtime") {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-violet-100 bg-gradient-to-l from-violet-50 to-white p-5">
          <p className="text-xs text-violet-700">بازدیدکنندگان فعال در ۳۰ دقیقه اخیر</p>
          <p className="mt-2 text-4xl font-semibold text-violet-950">
            {numberText(data.activeVisitors, 0)}
          </p>
          <p className="mt-2 text-xs text-violet-600">
            هر ۳۰ ثانیه بروز می‌شود، فقط وقتی این صفحه باز است
          </p>
        </div>
        <SimpleTable
          title="صفحات فعال در ۳۰ دقیقه اخیر"
          rows={asRows(data.topPages)}
          dimension="path"
          value={(row) => `${numberText(row.visitors, 0)} بازدیدکننده`}
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
              ارسال پرداخت‌های تأییدشده و مرجوعی‌ها از سرور به آمار:{" "}
              {delivery.status === "healthy"
                ? "سالم"
                : delivery.status === "attention"
                  ? "نیازمند رسیدگی"
                  : "در انتظار ثبت"}
            </p>
            <p className="mt-1">
              منتظر ثبت: {numberText(delivery.pending, 0)} · در حال ثبت:{" "}
              {numberText(delivery.processing, 0)} · نیازمند بررسی:{" "}
              {numberText(delivery.deadLetter, 0)}
            </p>
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <MetricTable title="صفحات پربازدید" rows={asRows(sections.path)} dimension="path" />
          <MetricTable
            title="راه‌های ورود کاربران"
            rows={asRows(sections.channel)}
            dimension="channel"
          />
          <MetricTable
            title="کارهای پرتکرار کاربران"
            rows={asRows(sections.event)}
            dimension="event"
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
          title="راه‌های ورود کاربران"
          rows={asRows(sections.channel)}
          dimension="channel"
        />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <MetricTable
            title="سایت‌هایی که کاربر را فرستاده‌اند"
            rows={asRows(sections.domain)}
            dimension="domain"
          />
          <MetricTable
            title="نشانی‌های ورودی"
            rows={asRows(sections.referrer)}
            dimension="referrer"
          />
        </div>
        <ReportBlock
          title="عملکرد کمپین‌های تبلیغاتی"
          description="منبع، روش انتشار، نام کمپین و نسخه محتوای تبلیغ"
        >
          <UtmSections value={sections.utm} />
        </ReportBlock>
        <ReportBlock
          title="منبع ورود خریداران"
          description="برای نشست‌هایی که به خرید تأییدشده رسیده‌اند: اولین و آخرین منبعی که در همان نشست دیده شده است."
        >
          <div className="space-y-4">
            <AttributionGroups value={sections.firstAttribution} title="اولین منبع" />
            <AttributionGroups value={sections.lastAttribution} title="آخرین منبع پیش از خرید" />
          </div>
        </ReportBlock>
      </div>
    );
  }
  if (view === "conversion") {
    const definitions = asRecord(sections.funnelDefinitions);
    const checkoutEvents = asRows(sections.event).filter((row) =>
      CHECKOUT_EVENT_NAMES.has(String(rawRowLabel(row) ?? "")),
    );
    return (
      <div className="space-y-4">
        <SummaryGrid
          summary={summary}
          comparison={payload.comparison ? previousSummary : undefined}
        />
        <ReportBlock
          title="فروش قطعی فروشگاه"
          description="مرجع عددهای مالی: مستقیماً از سفارش‌ها و پرداخت‌های فروشگاه محاسبه می‌شوند."
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
          title="تبدیل بازدید به خرید"
          description="خرید وقتی شمرده می‌شود که پرداخت در سرور تأیید شده و خریدار صفحه نتیجه پرداخت را دیده باشد. به‌خاطر مسدودکننده‌های تبلیغ یا بستن مرورگر، این عدد کمی کمتر از سفارش‌های پرداخت‌شده بالاست."
        >
          <GoalCard value={sections.purchaseGoal} />
        </ReportBlock>
        <FunnelVisualization
          title="از مشاهده محصول تا شروع ثبت سفارش"
          value={sections.discoveryFunnel}
          windowMinutes={asRecord(definitions.discovery).window}
        />
        <FunnelVisualization
          title="از شروع ثبت سفارش تا خرید"
          value={sections.checkoutFunnel}
          windowMinutes={asRecord(definitions.checkout).window}
        />
        <FunnelVisualization
          title="از انتقال به درگاه تا خرید"
          value={sections.paymentFunnel}
          windowMinutes={asRecord(definitions.payment).window}
        />
        <MetricTable
          title="اقدام‌های ثبت سفارش و پرداخت"
          rows={checkoutEvents}
          dimension="event"
        />
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
            title="نتیجه فیلتر محصول، دسته یا مدل"
            description="فقط این بخش فیلتر شده است: اقدام‌هایی که شناسه همان محصول، دسته یا مدل را دارند. پیش از نسخه جدید آمار، این شناسه‌ها فقط برای بازدیدکنندگانی ثبت می‌شد که «پذیرش» را زده بودند."
          >
            <div className="mb-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs text-slate-500">اقدام‌های مرتبط</p>
                <p className="mt-2 text-xl font-semibold">
                  {numberText(productFilter.matchedEvents, 0)}
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs text-slate-500">نمونه‌های بررسی‌شده (حداکثر ۱۰٬۰۰۰)</p>
                <p className="mt-2 text-xl font-semibold">
                  {numberText(productFilter.sampledEvents, 0)}
                </p>
              </div>
            </div>
            <SimpleTable
              title="مسیرهای مرتبط"
              rows={asRows(productFilter.paths)}
              dimension="path"
            />
          </ReportBlock>
        ) : null}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <MetricTable title="صفحه‌ها" rows={asRows(sections.path)} dimension="path" />
          <MetricTable title="اولین صفحه بازدید" rows={asRows(sections.entry)} dimension="path" />
          <MetricTable title="آخرین صفحه بازدید" rows={asRows(sections.exit)} dimension="path" />
          <MetricTable
            title="اقدام‌های مربوط به محتوا و محصول"
            rows={asRows(sections.event)}
            dimension="event"
          />
          <MetricTable title="نسخه‌ها و آزمایش‌ها" rows={asRows(sections.tag)} dimension="tag" />
        </div>
        <JourneyFlow rows={asRows(sections.journeys)} label={presentJourneyStep} />
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
          <MetricTable title="نوع دستگاه" rows={asRows(sections.device)} dimension="device" />
          <MetricTable title="مرورگر" rows={asRows(sections.browser)} dimension="browser" />
          <MetricTable title="سیستم‌عامل" rows={asRows(sections.os)} dimension="os" />
          <MetricTable title="زبان مرورگر" rows={asRows(sections.language)} dimension="language" />
          <MetricTable title="کشور" rows={asRows(sections.country)} dimension="country" />
          <MetricTable title="استان" rows={asRows(sections.region)} dimension="region" />
          <MetricTable title="شهر" rows={asRows(sections.city)} dimension="city" />
        </div>
        <ReportBlock
          title="بازگشت کاربران"
          description="چه تعداد از کاربران تا ۳۱ روز پس از اولین بازدید دوباره به فروشگاه برگشته‌اند."
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
        title="سرعت صفحه (Core Web Vitals)"
        description="عددها صدک ۷۵ هستند: ۷۵٪ بازدیدها سریع‌تر از این مقدار بوده‌اند. فقط بازدیدهایی شمرده می‌شوند که مرورگرشان سنجش سرعت را پشتیبانی می‌کند."
      >
        <PerformanceContent value={sections.performance} />
      </ReportBlock>
    </div>
  );
}

const FILTER_LABELS: Record<keyof BehaviorFilters, string> = {
  path: "نشانی صفحه",
  referrer: "سایت ارجاع‌دهنده",
  title: "عنوان صفحه",
  os: "سیستم‌عامل",
  browser: "مرورگر",
  device: "دستگاه",
  country: "کشور",
  region: "استان / منطقه",
  city: "شهر",
  tag: "نسخه یا آزمایش فعال",
  hostname: "نشانی فروشگاه",
  language: "زبان",
  event: "نام اقدام کاربر",
  utmSource: "منبع تبلیغ",
  utmMedium: "روش انتشار تبلیغ",
  utmCampaign: "نام کمپین",
  utmContent: "نسخه محتوای تبلیغ",
  utmTerm: "عبارت تبلیغاتی",
  segment: "بخش کاربران (شناسه از پنل Umami)",
  cohort: "گروه زمانی کاربران (شناسه از پنل Umami)",
  excludeBounce: "حذف بازدیدهای تک‌صفحه‌ای",
  match: "روش ترکیب شرط‌ها",
  productId: "شناسه محصول",
  categoryId: "شناسه دسته",
  variantId: "شناسه مدل محصول",
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
  // Funnels and the purchase goal are defined by their own steps, so an event
  // filter is not offered here (the backend ignores it for those reports).
  if (view === "conversion") return ["device", "browser", "utmSource", "path", "tag"];
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
    if (key === "event") {
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
            <option value="">همه اقدام‌ها</option>
            {FILTERABLE_EVENTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
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
            key === "path"
              ? "مثلاً /plp یا /pdp/نام-محصول"
              : key === "segment" || key === "cohort"
                ? "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                : ""
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
              ? "پنهان کردن فیلترهای تخصصی"
              : "فیلترهای تخصصی گزارش"}
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
            همه تاریخ‌ها و ساعت‌ها به وقت تهران محاسبه می‌شوند.
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
  const state = report.state;
  if (state === "ok") return null;
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
  const genericDetail = "بخشی از اطلاعات این گزارش موقتاً در دسترس نیست.";
  const details = Array.from(
    new Set(
      [report.error, ...(report.metadata.warnings ?? [])]
        .filter((message): message is string => Boolean(message?.trim()))
        .map(presentAnalyticsMessage),
    ),
  ).filter(
    (message) =>
      message !== labels[state] && message !== genericDetail,
  );
  return (
    <div
      className={`rounded-xl border px-4 py-3 text-sm ${tones[state]}`}
      role="status"
      data-state={state}
    >
      <p className="font-medium">{labels[state]}</p>
      {details.map((message) => (
        <p key={message} className="mt-1 text-xs opacity-80">
          {message}
        </p>
      ))}
    </div>
  );
}

function MetadataLine({ metadata }: { metadata: BehaviorMetadata }) {
  const startDate = metadata.dataStart
    ? new Date(`${metadata.dataStart.slice(0, 10)}T12:00:00+03:30`).toLocaleDateString("fa-IR")
    : "نامشخص";
  return (
    <div
      className="rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 text-xs text-slate-500"
      data-testid="behavior-metadata"
      data-start={metadata.dataStart ?? ""}
      data-stale={String(metadata.cache === "stale")}
    >
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <span>آمار از {startDate} موجود است.</span>
        <span>آخرین بروزرسانی: {dateTime(metadata.refreshedAt)}</span>
        <span>به وقت تهران</span>
        {metadata.cache === "stale" ? (
          <span className="font-medium text-amber-700">آخرین نسخه سالم گزارش نمایش داده شده است.</span>
        ) : null}
      </div>
      <details className="mt-2 border-t border-slate-200/70 pt-2">
        <summary className="cursor-pointer select-none font-medium text-slate-500">
          جزئیات فنی گزارش
        </summary>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400" dir="ltr">
          <span>source: {metadata.source ?? metadata.provider ?? "analytics"}</span>
          <span>timezone: {metadata.timezone ?? "Asia/Tehran"}</span>
          <span>cache: {metadata.cache ?? "miss"}</span>
          <span>definition: {metadata.definitionVersion ?? "unknown"}</span>
        </div>
      </details>
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
      title="بازدید و رفتار کاربران"
      description="ببینید کاربران از کجا می‌آیند، چه صفحه‌هایی را می‌بینند و در کدام مرحله به خرید می‌رسند."
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
          key={`${activeView}:${URL_FILTER_KEYS.map((key) => filters[key] ?? "").join("|")}`}
          view={activeView}
          filters={filters}
          onApply={applyFilters}
        />
        {requestError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {presentAnalyticsMessage(requestError)}
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
