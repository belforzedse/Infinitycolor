"use client";

import { useState } from "react";
import type { PurchaseTracking } from "@/types/super-admin/reports/behavior";
import { durationText, finite, numberText, ratioText } from "../format";
import { presentBehaviorValue } from "../presentation";
import { AnalyticsTable, LabelCell, ShareBar } from "./AnalyticsTable";
import { Notice, SectionHeader, Segmented } from "./ui";

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((row): row is Row => Boolean(row && typeof row === "object"))
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function label(row: Row): string {
  return String(row.label ?? row.name ?? "").trim();
}

type SourceKey = "referrer" | "domain" | "utmSource" | "utmMedium" | "utmCampaign";

/**
 * Each source table joins attributed buyers only on the same Umami column the
 * traffic row is keyed on, so «buyers ÷ visitors» compares one population.
 */
const SOURCES: ReadonlyArray<{
  id: SourceKey;
  label: string;
  attribution: "referrer" | "utm_source" | "utm_medium" | "utm_campaign" | null;
  dimension: "domain" | "referrer" | "generic";
}> = [
  { id: "referrer", label: "سایت ارجاع‌دهنده", attribution: "referrer", dimension: "referrer" },
  { id: "utmSource", label: "منبع کمپین", attribution: "utm_source", dimension: "generic" },
  { id: "utmMedium", label: "روش انتشار", attribution: "utm_medium", dimension: "generic" },
  { id: "utmCampaign", label: "نام کمپین", attribution: "utm_campaign", dimension: "generic" },
  { id: "domain", label: "دامنه ارجاع", attribution: null, dimension: "domain" },
];

type SourceRow = {
  key: string;
  raw: string;
  visitors: number | null;
  visits: number | null;
  buyers: number | null;
};

/** Umami's attribution report returns its top 20 values per dimension. */
const ATTRIBUTION_LIMIT = 20;

function sourceRows(traffic: Row[], attributed: Row[] | null): SourceRow[] {
  const buyers = new Map<string, number>();
  for (const row of attributed ?? []) {
    const value = finite(row.value);
    if (value !== null) buyers.set(label(row).toLowerCase(), value);
  }
  // A source missing from a full top-20 list may still have buyers: unknown, not 0.
  const absent = attributed && attributed.length < ATTRIBUTION_LIMIT ? 0 : null;
  return traffic.map((row) => {
    const raw = label(row);
    return {
      key: raw,
      raw,
      visitors: finite(row.visitors),
      visits: finite(row.visits),
      buyers: attributed ? (buyers.get(raw.toLowerCase()) ?? absent) : null,
    };
  });
}

function coverage(groups: Record<string, unknown>, key: string): number | null {
  const total = finite(record(groups.total).visitors);
  if (!total) return null;
  const sum = rows(groups[key]).reduce((acc, row) => acc + (finite(row.value) ?? 0), 0);
  return Math.min(1, sum / total);
}

export default function AcquisitionPanel({
  sections,
  summaryVisitors,
  tracking,
}: {
  sections: Record<string, unknown>;
  summaryVisitors: number | null;
  tracking: PurchaseTracking | null;
}) {
  const [source, setSource] = useState<SourceKey>("referrer");
  const [model, setModel] = useState<"first" | "last">("first");
  const channels = rows(sections.channel);
  const active = SOURCES.find((item) => item.id === source) ?? SOURCES[0];
  const groups = record(model === "first" ? sections.firstAttribution : sections.lastAttribution);
  const hasAttribution = Object.keys(groups).length > 0;
  const attributed =
    active.attribution && hasAttribution ? rows(groups[active.attribution]) : null;
  const purchaseIncomplete = tracking?.status === "not_live" || tracking?.status === "degraded";
  const tableRows = sourceRows(rows(sections[source]), purchaseIncomplete ? null : attributed);
  const covered = active.attribution ? coverage(groups, active.attribution) : null;
  const paidAds = rows(groups.paidAds);
  const utm = record(sections.utm);

  return (
    <div className="space-y-8">
      <section aria-labelledby="channels-title" className="space-y-3">
        <SectionHeader
          id="channels-title"
          title="راه‌های ورود"
          description="کیفیت هر راه ورود: سهم از بازدیدکنندگان و میزان درگیر شدن. «مستقیم» شامل هر بازدیدی است که منبعش معلوم نیست، نه فقط تایپ نشانی."
        />
        <AnalyticsTable
          caption="راه‌های ورود"
          rows={channels}
          rowKey={(row, index) => `${label(row)}-${index}`}
          defaultSort={{ key: "visitors", direction: "desc" }}
          minWidth={720}
          columns={[
            {
              key: "channel",
              label: "راه ورود",
              render: (row) => <LabelCell label={presentBehaviorValue(label(row), "channel")} />,
            },
            {
              key: "visitors",
              label: "بازدیدکننده",
              numeric: true,
              sortValue: (row) => finite(row.visitors),
              render: (row) => (
                <ShareBar
                  share={
                    summaryVisitors && finite(row.visitors) !== null
                      ? (finite(row.visitors) as number) / summaryVisitors
                      : null
                  }
                >
                  {numberText(row.visitors)}
                </ShareBar>
              ),
            },
            {
              key: "share",
              label: "سهم",
              numeric: true,
              render: (row) =>
                summaryVisitors ? ratioText((finite(row.visitors) ?? 0) / summaryVisitors) : "—",
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
              hint: "بازدید تک‌صفحه‌ای",
              numeric: true,
              sortValue: (row) => {
                const visits = finite(row.visits);
                const bounces = finite(row.bounces);
                return visits && bounces !== null ? bounces / visits : null;
              },
              render: (row) => {
                const visits = finite(row.visits);
                const bounces = finite(row.bounces);
                return ratioText(visits && bounces !== null ? bounces / visits : null);
              },
            },
            {
              key: "depth",
              label: "صفحه در هر بازدید",
              numeric: true,
              sortValue: (row) => {
                const visits = finite(row.visits);
                const pageviews = finite(row.pageviews);
                return visits && pageviews !== null ? pageviews / visits : null;
              },
              render: (row) => {
                const visits = finite(row.visits);
                const pageviews = finite(row.pageviews);
                return numberText(visits && pageviews !== null ? pageviews / visits : null, 1);
              },
            },
            {
              key: "time",
              label: "میانگین حضور",
              numeric: true,
              render: (row) => {
                const visits = finite(row.visits);
                const total = finite(row.totaltime);
                return durationText(visits && total !== null ? total / visits : null);
              },
            },
          ]}
        />
      </section>

      <section aria-labelledby="sources-title" className="space-y-3">
        <SectionHeader
          id="sources-title"
          title="منابع و کمپین‌ها: بازدید تا خرید"
          description="خریدار (مدل انتساب Umami) فقط با همان ستونی جفت می‌شود که بازدید با آن شمرده شده است. انتساب هم‌بستگی است، نه علت."
          actions={
            <>
              <Segmented
                label="بُعد منبع"
                size="sm"
                value={source}
                options={SOURCES.map(({ id, label: text }) => ({ id, label: text }))}
                onChange={setSource}
              />
              {active.attribution ? (
                <Segmented
                  label="مدل انتساب"
                  size="sm"
                  value={model}
                  options={[
                    { id: "first", label: "اولین منبع" },
                    { id: "last", label: "آخرین منبع پیش از خرید" },
                  ]}
                  onChange={setModel}
                />
              ) : null}
            </>
          }
        />
        {active.attribution ? (
          purchaseIncomplete ? (
            <Notice tone="warning">
              ردیابی خرید در این بازه کامل نیست؛ ستون خریدار نمایش داده نمی‌شود.
            </Notice>
          ) : !hasAttribution ? (
            <Notice>انتساب خرید برای این بازه در دسترس نیست.</Notice>
          ) : (
            <p className="text-[11px] leading-5 text-slate-600">
              {covered === null
                ? "خریداری در این بازه ثبت نشده است."
                : `${ratioText(covered)} از خریداران این بازه در این بُعد منبع مشخص دارند (بقیه مستقیم یا بدون ${active.label} بوده‌اند).`}{" "}
              {model === "last"
                ? "در این فروشگاه آخرین رخداد پیش از خرید معمولاً صفحه نتیجه پرداخت است که منبعی ندارد؛ پوشش کم این مدل از همین است."
                : null}
            </p>
          )
        ) : (
          <p className="text-[11px] text-slate-600">
            انتساب خرید برای دامنه‌های گروه‌بندی‌شده در دسترس نیست؛ «سایت ارجاع‌دهنده» را ببینید.
          </p>
        )}
        <AnalyticsTable
          caption={active.label}
          rows={tableRows}
          rowKey={(row) => row.key}
          defaultSort={{ key: "visitors", direction: "desc" }}
          columns={[
            {
              key: "source",
              label: active.label,
              render: (row) => (
                <LabelCell
                  label={presentBehaviorValue(row.raw, active.dimension)}
                  raw={active.dimension === "generic" ? null : row.raw}
                />
              ),
            },
            {
              key: "visitors",
              label: "بازدیدکننده",
              numeric: true,
              sortValue: (row) => row.visitors,
              render: (row) => numberText(row.visitors),
            },
            {
              key: "visits",
              label: "بازدید",
              numeric: true,
              sortValue: (row) => row.visits,
              render: (row) => numberText(row.visits),
            },
            ...(attributed && !purchaseIncomplete
              ? [
                  {
                    key: "buyers",
                    label: "خریدار",
                    hint: model === "first" ? "اولین منبع" : "آخرین منبع",
                    numeric: true,
                    sortValue: (row: SourceRow) => row.buyers,
                    render: (row: SourceRow) => numberText(row.buyers),
                  },
                  {
                    key: "rate",
                    label: "نرخ خرید",
                    hint: "خریدار ÷ بازدیدکننده",
                    numeric: true,
                    sortValue: (row: SourceRow) =>
                      row.buyers !== null && row.visitors ? row.buyers / row.visitors : null,
                    render: (row: SourceRow) =>
                      ratioText(row.buyers !== null && row.visitors ? row.buyers / row.visitors : null),
                  },
                ]
              : []),
          ]}
        />
        {paidAds.length && !purchaseIncomplete ? (
          <p className="text-[11px] text-slate-600">
            خرید از کلیک تبلیغ ({model === "first" ? "اولین" : "آخرین"} منبع):{" "}
            {paidAds.map((row) => `${label(row)} ${numberText(row.value)}`).join("، ")}
          </p>
        ) : null}
      </section>

      {rows(utm.utm_content).length || rows(utm.utm_term).length ? (
        <details className="group rounded-control border border-slate-100 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-800">
            جزئیات محتوا و عبارت کمپین‌ها
          </summary>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            {(["utm_content", "utm_term"] as const).map((key) => (
              <AnalyticsTable
                key={key}
                caption={key === "utm_content" ? "نسخه محتوای تبلیغ" : "عبارت تبلیغاتی"}
                rows={rows(utm[key])}
                rowKey={(row, index) => `${label(row)}-${index}`}
                minWidth={320}
                columns={[
                  {
                    key: "label",
                    label: key === "utm_content" ? "نسخه محتوا" : "عبارت",
                    render: (row) => <LabelCell label={label(row)} />,
                  },
                  {
                    key: "value",
                    label: "نمایش صفحه",
                    numeric: true,
                    render: (row) => numberText(row.value),
                  },
                ]}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
