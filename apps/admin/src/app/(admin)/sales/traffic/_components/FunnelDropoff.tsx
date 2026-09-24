"use client";

import { useState } from "react";
import JourneyFlow from "@/components/SuperAdmin/reports/shared/JourneyFlow";
import { FOCUS_RING, InlineLoadingState } from "@/components/admin";
import { cn } from "@/utils/tailwind";
import type { BehaviorQuery } from "@/types/super-admin/reports/behavior";
import type { FunnelAnalysis, FunnelStepView } from "../funnelSemantics";
import { finite, numberText, ratioText } from "../format";
import {
  CHECKOUT_EVENT_NAMES,
  presentAnalyticsMessage,
  presentBehaviorValue,
  presentFunnelStep,
  presentJourneyStep,
} from "../presentation";
import { AnalyticsTable, LabelCell } from "./AnalyticsTable";
import { Delta, Notice } from "./ui";
import { useConversionDetail } from "./useBehaviorData";

type Transition = { from: FunnelStepView; to: FunnelStepView };

function JourneysAfter({ step, query }: { step: string; query: BehaviorQuery }) {
  const detail = useConversionDetail({ detail: "journey", step }, query);
  const data = detail.report?.data as Record<string, unknown> | null | undefined;
  const sections = (data?.sections ?? {}) as Record<string, unknown>;
  const supported = data?.kind === "conversion-journey";
  return (
    <div className="mt-4 rounded-control border border-slate-100 p-3 md:p-4">
      <h4 className="text-sm font-semibold text-slate-900">
        بازدیدکنندگان پس از «{presentFunnelStep(step)}» واقعاً چه کردند؟
      </h4>
      <p className="mt-1 text-xs leading-5 text-slate-600">
        مسیرهای واقعی، نه قیف: هر ردیف یک بازدید است (حداکثر ۴ گام)، صفحه‌ها و اقدام‌ها به ترتیب
        وقوع. برای دیدن بازدیدکنندگانی که ادامه ندادند، شاخه‌هایی را دنبال کنید که به مرحله بعد
        نرسیده‌اند.
      </p>
      <div className="mt-3">
        {detail.loading && !detail.report ? (
          <InlineLoadingState label="در حال دریافت مسیرها…" />
        ) : detail.requestError || detail.report?.state === "unavailable" ? (
          <Notice tone="warning">
            {presentAnalyticsMessage(detail.requestError ?? detail.report?.error)}
          </Notice>
        ) : data && !supported ? (
          <Notice>این نما به نسخه جدید سرور گزارش نیاز دارد.</Notice>
        ) : (
          <JourneyFlow
            rows={Array.isArray(sections.journeys) ? sections.journeys : []}
            label={presentJourneyStep}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The «ریزش» view: every step-to-step loss, ranked by how many people it cost,
 * against the previous period, with the real paths after any step on demand.
 */
export default function FunnelDropoff({
  analysis,
  compare,
  query,
  funnelLabel,
  events,
}: {
  analysis: FunnelAnalysis;
  compare: boolean;
  query: BehaviorQuery;
  funnelLabel: string;
  /** The conversion view's event table; only checkout and payment events are shown. */
  events: unknown;
}) {
  const checkoutEvents = (Array.isArray(events) ? events : []).filter(
    (row): row is Record<string, unknown> =>
      Boolean(row && typeof row === "object") &&
      CHECKOUT_EVENT_NAMES.has(String((row as Record<string, unknown>).label ?? "")),
  );
  const [journeyStep, setJourneyStep] = useState<string | null>(null);
  const transitions: Transition[] = analysis.steps
    .slice(1)
    .map((to, index) => ({ from: analysis.steps[index], to }))
    .filter(({ to }) => !to.unreliable);

  return (
    <div>
      <AnalyticsTable
        caption={`ریزش مرحله به مرحله در ${funnelLabel}`}
        rows={transitions}
        rowKey={({ to }) => to.event}
        defaultSort={{ key: "lost", direction: "desc" }}
        minWidth={720}
        rowClassName={({ to }) =>
          analysis.largestDrop?.index === to.index ? "bg-rose-50/50" : undefined
        }
        columns={[
          {
            key: "step",
            label: "مرحله",
            render: ({ from, to }) => (
              <span className="block whitespace-nowrap font-medium text-slate-900">
                {presentFunnelStep(from.event)}
                <span className="text-slate-500"> ← </span>
                {presentFunnelStep(to.event)}
              </span>
            ),
          },
          {
            key: "entered",
            label: "رسیده به مرحله قبل",
            numeric: true,
            render: ({ from }) => numberText(from.count),
          },
          {
            key: "continued",
            label: "ادامه دادند",
            numeric: true,
            sortValue: ({ to }) => to.count,
            render: ({ to }) => numberText(to.count),
          },
          {
            key: "lost",
            label: "ریزش (نفر)",
            numeric: true,
            sortValue: ({ to }) => to.lost,
            render: ({ to }) => <strong className="font-semibold">{numberText(to.lost)}</strong>,
          },
          {
            key: "rate",
            label: "نرخ ریزش",
            hint: "از رسیدگان به مرحله قبل",
            numeric: true,
            sortValue: ({ to }) => to.dropoffRate,
            render: ({ to }) => ratioText(to.dropoffRate),
          },
          ...(compare
            ? [
                {
                  key: "previous",
                  label: "نرخ ریزش دوره قبل",
                  numeric: true,
                  render: ({ to }: Transition) => ratioText(to.previous?.dropoffRate),
                },
                {
                  key: "change",
                  label: "تغییر",
                  numeric: true,
                  sortValue: ({ to }: Transition) =>
                    to.fromPreviousChangePp === null ? null : -to.fromPreviousChangePp,
                  render: ({ to }: Transition) => (
                    // A falling drop-off rate is good, so show the drop-off change
                    // (the negation of the continuation change) with lower-is-better.
                    <Delta
                      change={to.fromPreviousChangePp === null ? null : -to.fromPreviousChangePp}
                      kind="points"
                      lowerIsBetter
                    />
                  ),
                },
              ]
            : []),
          {
            key: "journeys",
            label: <span className="sr-only">مسیرهای بعدی</span>,
            render: ({ from }) => (
              <button
                type="button"
                aria-pressed={journeyStep === from.event}
                title="بازدیدکنندگان پس از این مرحله واقعاً چه کردند؟"
                onClick={() =>
                  setJourneyStep((current) => (current === from.event ? null : from.event))
                }
                className={cn(
                  "whitespace-nowrap rounded text-xs font-medium text-infinity-primary hover:underline",
                  FOCUS_RING,
                )}
              >
                {journeyStep === from.event ? "بستن مسیرها" : "مسیرهای بعدی"}
              </button>
            ),
          },
        ]}
      />
      {journeyStep ? <JourneysAfter step={journeyStep} query={query} /> : null}
      <div className="mt-6 space-y-2">
        <h4 className="text-sm font-semibold text-slate-900">رخدادهای ثبت سفارش و پرداخت</h4>
        <p className="text-xs leading-5 text-slate-600">
          شواهد ریزش: خطاهای ثبت سفارش، پرداخت‌های ناموفق و لغوشده. «دفعات» هر بار وقوع است و
          «بازدیدکننده» هر نفر یک بار؛ این‌ها مراحل قیف نیستند و به ترتیب شمرده نمی‌شوند.
        </p>
        <AnalyticsTable
          caption="رخدادهای ثبت سفارش و پرداخت"
          rows={checkoutEvents}
          rowKey={(row, index) => `${String(row.label)}-${index}`}
          defaultSort={{ key: "visitors", direction: "desc" }}
          minWidth={480}
          columns={[
            {
              key: "event",
              label: "اقدام",
              render: (row) => (
                <LabelCell label={presentBehaviorValue(row.label, "event")} raw={String(row.label)} />
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
          ]}
        />
      </div>
    </div>
  );
}
