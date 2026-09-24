"use client";

import { createElement, useState, type ComponentType } from "react";
import {
  CheckCircle2,
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
  XCircle,
  AlertTriangle,
} from "lucide-react";
import { FaChrome, FaEdge, FaFirefoxBrowser, FaInstagram, FaOpera, FaSafari, FaWindows } from "react-icons/fa";
import { SiAndroid, SiApple, SiLinux } from "react-icons/si";
import { dateText, finite, numberText, percentText, ratioText } from "@/components/SuperAdmin/reports/shared/format";
import {
  measuredPerformanceRows,
  performanceP75,
  presentBehaviorValue,
  rateVital,
  VITAL_RATING_LABELS,
  VITAL_THRESHOLDS,
  type BehaviorDimension,
  type VitalKey,
  type VitalRating,
} from "../presentation";
import { AnalyticsTable, LabelCell, ShareCell } from "@/components/SuperAdmin/reports/shared/AnalyticsTable";
import CompositionBars from "./CompositionBars";
import { Notice, SectionHeader, Segmented } from "@/components/SuperAdmin/reports/shared/ui";
import WeeklyHeatmap from "@/components/SuperAdmin/reports/shared/WeeklyHeatmap";

type Row = Record<string, unknown>;
type Icon = ComponentType<{ "aria-hidden"?: boolean; className?: string; focusable?: boolean }>;

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((row): row is Row => Boolean(row && typeof row === "object"))
    : [];
}

function label(row: Row): string {
  return String(row.label ?? row.name ?? "").trim();
}

function machineKey(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[-_\s]/g, "");
}

const DEVICE_ICONS: Record<string, Icon> = {
  desktop: Monitor,
  laptop: Laptop,
  mobile: Smartphone,
  phone: Smartphone,
  tablet: Tablet,
  smarttv: Tv,
  console: Gamepad2,
  wearable: Watch,
};
const BROWSER_ICONS: Record<string, Icon> = {
  chrome: FaChrome,
  crios: FaChrome,
  chromium: FaChrome,
  chromiumwebview: FaChrome,
  edge: FaEdge,
  edgechromium: FaEdge,
  firefox: FaFirefoxBrowser,
  opera: FaOpera,
  safari: FaSafari,
  ios: FaSafari,
  instagram: FaInstagram,
};
const OS_ICONS: Record<string, Icon> = {
  android: SiAndroid,
  androidos: SiAndroid,
  ios: SiApple,
  ipados: SiApple,
  macos: SiApple,
  linux: SiLinux,
  windows: FaWindows,
  windows10: FaWindows,
  windows7: FaWindows,
};

function iconFor(value: string, dimension: BehaviorDimension) {
  const key = machineKey(value);
  const icon =
    dimension === "device"
      ? DEVICE_ICONS[key] ?? MonitorSmartphone
      : dimension === "browser"
        ? BROWSER_ICONS[key] ?? Globe2
        : dimension === "os"
          ? OS_ICONS[key] ?? Cpu
          : null;
  return icon ? (
    <span className="grid size-6 shrink-0 place-items-center text-slate-500" data-dimension-icon={dimension}>
      {createElement(icon, { "aria-hidden": true, className: "size-3.5", focusable: false })}
    </span>
  ) : undefined;
}

function DimensionTable({
  caption,
  sectionRows,
  dimension,
  summaryVisitors,
}: {
  caption: string;
  sectionRows: Row[];
  dimension: BehaviorDimension;
  summaryVisitors: number | null;
}) {
  return (
    <AnalyticsTable
      caption={caption}
      rows={sectionRows}
      rowKey={(row, index) => `${label(row)}-${index}`}
      defaultSort={{ key: "visitors", direction: "desc" }}
      // Two of these sit side by side on desktop; keep all four columns in view.
      minWidth={400}
      columns={[
        {
          key: "label",
          label: caption,
          render: (row) => (
            <LabelCell
              label={presentBehaviorValue(label(row), dimension)}
              raw={
                dimension === "country" || dimension === "language" || dimension === "screen"
                  ? null
                  : label(row)
              }
              icon={iconFor(label(row), dimension)}
              maxWidth={200}
            />
          ),
        },
        {
          key: "visitors",
          label: "بازدیدکننده",
          numeric: true,
          sortValue: (row) => finite(row.visitors),
          render: (row) => (
            <ShareCell
              share={
                summaryVisitors && finite(row.visitors) !== null
                  ? (finite(row.visitors) as number) / summaryVisitors
                  : null
              }
            >
              {numberText(row.visitors)}
            </ShareCell>
          ),
        },
        {
          key: "visits",
          label: "بازدید",
          numeric: true,
          sortValue: (row) => finite(row.visits),
          render: (row) => numberText(row.visits),
        },
        {
          key: "bounce",
          label: "نرخ پرش",
          numeric: true,
          render: (row) => {
            const visits = finite(row.visits);
            const bounces = finite(row.bounces);
            return ratioText(visits && bounces !== null ? bounces / visits : null);
          },
        },
      ]}
    />
  );
}

type TechView = "device" | "os" | "browser" | "screen";
type GeoView = "country" | "region" | "city" | "language";

export function AudiencePanel({
  sections,
  previousSections,
  summaryVisitors,
}: {
  sections: Record<string, unknown>;
  /** The same report for the previous period, when comparing. */
  previousSections?: Record<string, unknown> | null;
  summaryVisitors: number | null;
}) {
  const [tech, setTech] = useState<TechView>("device");
  const [geo, setGeo] = useState<GeoView>("region");
  const techOptions = [
    { id: "device" as const, label: "دستگاه" },
    { id: "os" as const, label: "سیستم‌عامل" },
    { id: "browser" as const, label: "مرورگر" },
    // Older servers do not send screens; offer the view only when they do.
    ...(Array.isArray(sections.screen) ? [{ id: "screen" as const, label: "اندازه صفحه" }] : []),
  ];
  const geoOptions = [
    { id: "region" as const, label: "استان" },
    { id: "city" as const, label: "شهر" },
    { id: "country" as const, label: "کشور" },
    { id: "language" as const, label: "زبان" },
  ];
  const retention = rows(sections.retention);
  return (
    <div className="space-y-10">
      <CompositionBars sections={sections} previousSections={previousSections} />
      <WeeklyHeatmap
        value={sections.weekly}
        id="weekly-title"
        title="ساعت‌های حضور"
        unit="نشست فعال"
        intro="میانگین نشست‌های فعال در هر ساعت، به وقت تهران."
      />
      <div className="grid gap-8 xl:grid-cols-2">
        <section aria-labelledby="tech-title" className="min-w-0 space-y-3">
          <SectionHeader
            id="tech-title"
            title="دستگاه و مرورگر"
            description="تفاوت تبدیل این گروه‌ها را در قیف، نمای «تفکیک» ببینید."
            actions={<Segmented label="بُعد فنی" size="sm" value={tech} options={techOptions} onChange={setTech} />}
          />
          <DimensionTable
            caption={techOptions.find((option) => option.id === tech)?.label ?? ""}
            sectionRows={rows(sections[tech])}
            dimension={tech}
            summaryVisitors={summaryVisitors}
          />
        </section>
        <section aria-labelledby="geo-title" className="min-w-0 space-y-3">
          <SectionHeader
            id="geo-title"
            title="مکان و زبان"
            description="مکان از روی IP تخمین زده می‌شود؛ برای بخش بزرگی از بازدیدها (VPN، اینترنت همراه) استان مشخص نیست."
            actions={<Segmented label="بُعد مکانی" size="sm" value={geo} options={geoOptions} onChange={setGeo} />}
          />
          <DimensionTable
            caption={geoOptions.find((option) => option.id === geo)?.label ?? ""}
            sectionRows={rows(sections[geo])}
            dimension={geo}
            summaryVisitors={summaryVisitors}
          />
        </section>
      </div>
      <section aria-labelledby="retention-title" className="space-y-3">
        <SectionHeader
          id="retention-title"
          title="بازگشت بازدیدکنندگان"
          description="از بازدیدکنندگانی که در یک روز برای اولین بار آمدند، چند درصد چند روز بعد برگشتند (تا ۳۱ روز)."
        />
        <AnalyticsTable
          caption="بازگشت بازدیدکنندگان"
          rows={retention}
          rowKey={(row, index) => `${String(row.date)}-${String(row.day)}-${index}`}
          maxRows={40}
          columns={[
            {
              key: "date",
              label: "روز اولین بازدید",
              render: (row) => dateText(String(row.date ?? "").slice(0, 10)),
            },
            {
              key: "day",
              label: "چند روز بعد",
              numeric: true,
              render: (row) => numberText(row.day),
            },
            {
              key: "visitors",
              label: "بازدیدکنندگان گروه",
              numeric: true,
              render: (row) => numberText(row.visitors),
            },
            {
              key: "returned",
              label: "برگشتند",
              numeric: true,
              render: (row) => numberText(row.returnVisitors),
            },
            {
              key: "percentage",
              label: "درصد بازگشت",
              numeric: true,
              render: (row) => <strong className="font-semibold">{percentText(row.percentage)}</strong>,
            },
          ]}
        />
      </section>
    </div>
  );
}

const VITALS: ReadonlyArray<{ key: VitalKey; label: string; description: string }> = [
  { key: "lcp", label: "LCP", description: "نمایش محتوای اصلی صفحه" },
  { key: "inp", label: "INP", description: "واکنش صفحه به کلیک و لمس" },
  { key: "cls", label: "CLS", description: "جابه‌جایی ناگهانی اجزای صفحه" },
  { key: "fcp", label: "FCP", description: "نمایش نخستین محتوای صفحه" },
  { key: "ttfb", label: "TTFB", description: "دریافت نخستین پاسخ از سرور" },
];

const RATING_ICON: Record<VitalRating, Icon> = {
  good: CheckCircle2,
  needs_improvement: AlertTriangle,
  poor: XCircle,
};

function vitalText(key: VitalKey, value: number | null) {
  if (value === null) return "—";
  return key === "cls" ? numberText(value, 3) : `${numberText(value)} میلی‌ثانیه`;
}

function thresholdText(key: VitalKey) {
  const [good, poor] = VITAL_THRESHOLDS[key];
  return key === "cls"
    ? `خوب تا ${numberText(good, 2)}، ضعیف بالای ${numberText(poor, 2)}`
    : `خوب تا ${numberText(good)}، ضعیف بالای ${numberText(poor)} میلی‌ثانیه`;
}

function RatingBadge({ rating }: { rating: VitalRating | null }) {
  if (!rating) return <span className="text-slate-500">—</span>;
  const Icon = RATING_ICON[rating];
  return (
    <span
      className={
        rating === "good"
          ? "inline-flex items-center gap-1 text-emerald-800"
          : rating === "needs_improvement"
            ? "inline-flex items-center gap-1 text-amber-800"
            : "inline-flex items-center gap-1 text-rose-800"
      }
    >
      {createElement(Icon, { "aria-hidden": true, className: "size-3.5" })}
      {VITAL_RATING_LABELS[rating]}
    </span>
  );
}

type PerfView = "pages" | "devices" | "browsers" | "pageTitles";

export function PerformancePanel({ sections }: { sections: Record<string, unknown> }) {
  const [view, setView] = useState<PerfView>("pages");
  const performance =
    sections.performance && typeof sections.performance === "object"
      ? (sections.performance as Record<string, unknown>)
      : {};
  const summary = (performance.summary ?? {}) as Record<string, unknown>;
  const vitals = VITALS.map((vital) => {
    const value = performanceP75(
      summary[vital.key] ?? summary[`${vital.key}Avg`] ?? summary[`avg${vital.key.toUpperCase()}`],
    );
    return { ...vital, value, rating: rateVital(vital.key, value) };
  });
  const measured = vitals.filter((vital) => vital.value !== null);
  const options = [
    { id: "pages" as const, label: "صفحه" },
    { id: "devices" as const, label: "دستگاه" },
    { id: "browsers" as const, label: "مرورگر" },
    { id: "pageTitles" as const, label: "عنوان صفحه" },
  ];
  const dimension: BehaviorDimension =
    view === "pages" ? "path" : view === "devices" ? "device" : view === "browsers" ? "browser" : "generic";
  const detailRows = measuredPerformanceRows(performance[view]);
  return (
    <div className="space-y-8">
      <section aria-labelledby="vitals-title" className="space-y-3">
        <SectionHeader
          id="vitals-title"
          title="سرعت صفحه (Core Web Vitals)"
          description="صدک ۷۵: سه‌چهارم بازدیدها سریع‌تر از این مقدار بوده‌اند. فقط مرورگرهایی شمرده می‌شوند که سنجش سرعت را پشتیبانی می‌کنند."
        />
        {measured.length ? (
          <AnalyticsTable
            caption="Core Web Vitals"
            rows={vitals}
            rowKey={(vital) => vital.key}
            minWidth={620}
            columns={[
              {
                key: "metric",
                label: "شاخص",
                render: (vital) => (
                  <span>
                    <span className="font-semibold" dir="ltr">
                      {vital.label}
                    </span>
                    <span className="block text-[11px] text-slate-600">{vital.description}</span>
                  </span>
                ),
              },
              {
                key: "value",
                label: "صدک ۷۵",
                numeric: true,
                render: (vital) => <strong className="font-semibold">{vitalText(vital.key, vital.value)}</strong>,
              },
              {
                key: "rating",
                label: "وضعیت",
                render: (vital) => <RatingBadge rating={vital.rating} />,
              },
              {
                key: "threshold",
                label: "مرز",
                render: (vital) => <span className="text-[11px] text-slate-600">{thresholdText(vital.key)}</span>,
              },
            ]}
          />
        ) : (
          <Notice>برای این بازه سنجش سرعتی ثبت نشده است.</Notice>
        )}
      </section>
      <section aria-labelledby="lcp-title" className="space-y-3">
        <SectionHeader
          id="lcp-title"
          title="نمایش محتوای اصلی (LCP) به تفکیک"
          actions={<Segmented label="تفکیک LCP" size="sm" value={view} options={options} onChange={setView} />}
        />
        <AnalyticsTable
          caption="LCP به تفکیک"
          rows={detailRows}
          rowKey={(row, index) => `${String(row.name)}-${index}`}
          defaultSort={{ key: "p75", direction: "desc" }}
          columns={[
            {
              key: "name",
              label: options.find((option) => option.id === view)?.label ?? "",
              render: (row) =>
                dimension === "generic" ? (
                  <LabelCell label={String(row.name)} />
                ) : (
                  <LabelCell
                    label={presentBehaviorValue(row.name, dimension)}
                    raw={String(row.name)}
                    icon={iconFor(String(row.name), dimension)}
                  />
                ),
            },
            {
              key: "p75",
              label: "صدک ۷۵",
              numeric: true,
              sortValue: (row) => performanceP75(row),
              render: (row) => vitalText("lcp", performanceP75(row)),
            },
            {
              key: "rating",
              label: "وضعیت",
              render: (row) => <RatingBadge rating={rateVital("lcp", performanceP75(row))} />,
            },
            {
              key: "count",
              label: "سنجش",
              numeric: true,
              sortValue: (row) => finite(row.count),
              render: (row) => numberText(row.count),
            },
          ]}
        />
      </section>
    </div>
  );
}
