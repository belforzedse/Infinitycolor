"use client";

import { useState } from "react";
import JourneyFlow from "@/components/SuperAdmin/reports/shared/JourneyFlow";
import { durationText, finite, numberText, ratioText } from "@/components/SuperAdmin/reports/shared/format";
import {
  CHECKOUT_EVENT_NAMES,
  presentBehaviorValue,
  presentJourneyStep,
  presentPath,
} from "../presentation";
import { AnalyticsTable, LabelCell, ShareCell } from "@/components/SuperAdmin/reports/shared/AnalyticsTable";
import { SectionHeader, Segmented } from "@/components/SuperAdmin/reports/shared/ui";

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((row): row is Row => Boolean(row && typeof row === "object"))
    : [];
}

function label(row: Row): string {
  return String(row.label ?? row.name ?? "").trim();
}

type PageView = "entry" | "path" | "exit" | "title";

const PAGE_VIEWS: ReadonlyArray<{ id: PageView; label: string; description: string }> = [
  {
    id: "entry",
    label: "صفحه ورود",
    description: "اولین صفحه هر بازدید: کیفیت ورود را با نرخ پرش و زمان حضور بسنجید.",
  },
  { id: "path", label: "پربازدیدترین", description: "همه نمایش‌های هر صفحه در بازه." },
  { id: "exit", label: "صفحه خروج", description: "آخرین صفحه هر بازدید پیش از ترک سایت." },
  { id: "title", label: "عنوان صفحه", description: "همان صفحه‌ها بر اساس عنوان؛ صفحه‌های حساس عنوان ندارند." },
];

const bounceRate = (row: Row) => {
  const visits = finite(row.visits);
  const bounces = finite(row.bounces);
  return visits && bounces !== null ? bounces / visits : null;
};

const averageTime = (row: Row) => {
  const visits = finite(row.visits);
  const total = finite(row.totaltime);
  return visits && total !== null ? total / visits : null;
};

export default function ContentPanel({
  sections,
  summaryVisitors,
}: {
  sections: Record<string, unknown>;
  summaryVisitors: number | null;
}) {
  const [pageView, setPageView] = useState<PageView>("entry");
  const active = PAGE_VIEWS.find((item) => item.id === pageView) ?? PAGE_VIEWS[0];
  const pageRows = rows(sections[pageView]);
  const events = rows(sections.event);
  const productFilter =
    sections.productFilter && typeof sections.productFilter === "object"
      ? (sections.productFilter as Row)
      : null;

  return (
    <div className="space-y-8">
      <section aria-labelledby="pages-title" className="space-y-3">
        <SectionHeader
          id="pages-title"
          title="صفحه‌ها"
          description={active.description}
          actions={
            <Segmented
              label="نمای صفحه‌ها"
              size="sm"
              value={pageView}
              options={PAGE_VIEWS.map(({ id, label: text }) => ({ id, label: text }))}
              onChange={setPageView}
            />
          }
        />
        <AnalyticsTable
          caption={active.label}
          rows={pageRows}
          rowKey={(row, index) => `${label(row)}-${index}`}
          defaultSort={{ key: pageView === "path" || pageView === "title" ? "pageviews" : "visits", direction: "desc" }}
          minWidth={680}
          columns={[
            {
              key: "page",
              label: pageView === "title" ? "عنوان" : "صفحه",
              render: (row) =>
                pageView === "title" ? (
                  <LabelCell label={label(row) || "بدون عنوان"} />
                ) : (
                  <LabelCell label={presentPath(label(row))} raw={label(row)} />
                ),
            },
            ...(pageView === "entry" || pageView === "exit"
              ? [
                  {
                    key: "visits",
                    label: pageView === "entry" ? "ورود" : "خروج",
                    hint: "تعداد بازدید",
                    numeric: true,
                    sortValue: (row: Row) => finite(row.visits),
                    render: (row: Row) => numberText(row.visits),
                  },
                ]
              : [
                  {
                    key: "pageviews",
                    label: "نمایش صفحه",
                    numeric: true,
                    sortValue: (row: Row) => finite(row.pageviews),
                    render: (row: Row) => numberText(row.pageviews),
                  },
                ]),
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
            ...(pageView === "entry"
              ? [
                  {
                    key: "bounce",
                    label: "نرخ پرش",
                    numeric: true,
                    sortValue: bounceRate,
                    render: (row: Row) => ratioText(bounceRate(row)),
                  },
                  {
                    key: "time",
                    label: "میانگین حضور",
                    numeric: true,
                    sortValue: averageTime,
                    render: (row: Row) => durationText(averageTime(row)),
                  },
                ]
              : []),
          ]}
        />
      </section>

      <section aria-labelledby="events-title" className="space-y-3">
        <SectionHeader
          id="events-title"
          title="اقدام‌های کاربران"
          description="هر اقدام چند بار انجام شده و چند بازدیدکننده آن را انجام داده‌اند. رخدادهای تشخیصی سرور در این جدول نیستند."
        />
        <AnalyticsTable
          caption="اقدام‌های کاربران"
          rows={events}
          rowKey={(row, index) => `${label(row)}-${index}`}
          defaultSort={{ key: "visitors", direction: "desc" }}
          columns={[
            {
              key: "event",
              label: "اقدام",
              render: (row) => (
                <LabelCell
                  label={presentBehaviorValue(label(row), "event")}
                  raw={label(row)}
                  icon={
                    CHECKOUT_EVENT_NAMES.has(label(row)) ? (
                      <span className="shrink-0 rounded-sm bg-slate-100 px-1 text-[10px] text-slate-600">
                        خرید
                      </span>
                    ) : undefined
                  }
                />
              ),
            },
            {
              key: "count",
              label: "دفعات",
              numeric: true,
              sortValue: (row) => finite(row.count),
              render: (row) => numberText(row.count),
            },
            {
              key: "visitors",
              label: "بازدیدکننده",
              numeric: true,
              sortValue: (row) => finite(row.visitors),
              render: (row) => numberText(row.visitors),
            },
            {
              key: "share",
              label: "سهم بازدیدکنندگان",
              numeric: true,
              render: (row) =>
                summaryVisitors ? ratioText((finite(row.visitors) ?? 0) / summaryVisitors) : "—",
            },
          ]}
        />
      </section>

      {productFilter ? (
        <section aria-labelledby="product-filter-title" className="space-y-3">
          <SectionHeader
            id="product-filter-title"
            title="شواهد محصول، دسته یا مدل انتخاب‌شده"
            description={`${numberText(productFilter.matchedEvents)} اقدام مرتبط (از ${numberText(productFilter.sampledEvents)} نمونه بررسی‌شده، حداکثر ۱۰٬۰۰۰). فقط این بخش با شناسه محصول فیلتر شده است.`}
          />
          <AnalyticsTable
            caption="مسیرهای مرتبط با محصول"
            rows={rows(productFilter.paths)}
            rowKey={(row, index) => `${label(row)}-${index}`}
            minWidth={420}
            columns={[
              {
                key: "path",
                label: "صفحه",
                render: (row) => <LabelCell label={presentPath(label(row))} raw={label(row)} />,
              },
              {
                key: "value",
                label: "اقدام",
                numeric: true,
                render: (row) => numberText(row.value),
              },
            ]}
          />
        </section>
      ) : null}

      <section aria-labelledby="journeys-title" className="space-y-3">
        <SectionHeader
          id="journeys-title"
          title="مسیرهای واقعی بازدیدکنندگان"
          description="قیف مسیر مورد انتظار را می‌سنجد؛ این نمودار مسیرهایی را نشان می‌دهد که بازدیدکنندگان واقعاً طی کرده‌اند (حداکثر ۴ گام در هر بازدید)."
        />
        <JourneyFlow rows={rows(sections.journeys)} label={presentJourneyStep} />
      </section>

      {rows(sections.tag).length ? (
        <details className="rounded-control border border-slate-100 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-800">
            نسخه‌ها و آزمایش‌ها
          </summary>
          <div className="mt-3">
            <AnalyticsTable
              caption="نسخه‌ها و آزمایش‌ها"
              rows={rows(sections.tag)}
              rowKey={(row, index) => `${label(row)}-${index}`}
              minWidth={420}
              columns={[
                {
                  key: "tag",
                  label: "نسخه یا آزمایش",
                  render: (row) => <LabelCell label={presentBehaviorValue(label(row), "tag")} raw={label(row)} />,
                },
                {
                  key: "visitors",
                  label: "بازدیدکننده",
                  numeric: true,
                  render: (row) => numberText(row.visitors),
                },
                {
                  key: "pageviews",
                  label: "نمایش صفحه",
                  numeric: true,
                  render: (row) => numberText(row.pageviews),
                },
              ]}
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}
