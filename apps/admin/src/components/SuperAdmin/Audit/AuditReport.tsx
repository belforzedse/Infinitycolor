"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  ChevronDown,
  ExternalLink,
  FilterX,
  Search,
  ShieldCheck,
  UserRound,
  UsersRound,
} from "lucide-react";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import ReportDateRangeField from "@/components/SuperAdmin/reports/shared/ReportDateRangeField";
import ReportExportButton from "@/components/SuperAdmin/reports/shared/ReportExportButton";
import {
  parseDateOnly,
  toDateOnly,
  useReportQueryState,
} from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import { faNum } from "@/utils/faNum";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import {
  downloadAuditExport,
  getAuditEvent,
  getAuditEvents,
  getAuditFilterOptions,
  getAuditSummary,
  type AuditEvent,
  type AuditFilterOptions,
  type AuditMode,
  type AuditOrigin,
  type AuditQuery,
  type AuditResult,
  type AuditSummary,
} from "@/services/audit";
import AuditEventDrawer from "./AuditEventDrawer";
import {
  DOMAIN_LABELS,
  ORIGIN_LABELS,
  RESULT_LABELS,
  auditEventLabel,
  auditTargetTypeLabel,
  describeAuditEvent,
  entityHref,
  formatAuditTime,
  principalLabel,
  targetLabel,
} from "./auditPresentation";

const FILTER_KEYS = [
  "mode",
  "admin",
  "origin",
  "domain",
  "eventKey",
  "targetType",
  "targetId",
  "result",
  "importance",
  "q",
  "event",
] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

const MODES: Array<{ value: AuditMode; label: string; icon: typeof UserRound }> = [
  { value: "human", label: "اقدام‌های مدیران", icon: UserRound },
  { value: "automatic", label: "اجراهای خودکار", icon: Bot },
  { value: "all", label: "همه فعالیت‌ها", icon: ShieldCheck },
];

const inputClass =
  "h-11 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-700 outline-none transition focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/15 motion-reduce:transition-none";

function isoRange(start: string, end: string) {
  const startDate = parseDateOnly(start) || new Date(Date.now() - 30 * 86_400_000);
  const endDate = parseDateOnly(end) || new Date();
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(23, 59, 59, 999);
  return { from: startDate.toISOString(), to: endDate.toISOString() };
}

function SummaryCard({
  title,
  value,
  detail,
  icon: Icon,
  tone,
  loading,
}: {
  title: string;
  value: number;
  detail?: string;
  icon: typeof UserRound;
  tone: string;
  loading: boolean;
}) {
  return (
    <div className="rounded-2xl border border-neutral-100 bg-white p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-neutral-500">{title}</p>
          {loading ? (
            <div className="mt-3 h-7 w-20 animate-pulse rounded bg-neutral-100 motion-reduce:animate-none" />
          ) : (
            <p className="mt-2 text-2xl font-bold tabular-nums text-neutral-800">{faNum(value)}</p>
          )}
          {detail && <p className="mt-1 text-[11px] text-neutral-400">{detail}</p>}
        </div>
        <span className={`grid size-9 place-items-center rounded-xl ${tone}`}>
          <Icon className="size-4.5" aria-hidden />
        </span>
      </div>
    </div>
  );
}

function ActivitySplitChart({ summary, loading }: { summary: AuditSummary | null; loading: boolean }) {
  const series = summary?.series.slice(-31) || [];
  const maximum = Math.max(1, ...series.map((item) => item.human + item.automatic));
  return (
    <figure className="rounded-2xl border border-neutral-100 bg-white p-4 sm:p-5" aria-labelledby="audit-chart-title">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <figcaption>
          <h2 id="audit-chart-title" className="text-sm font-semibold text-neutral-800">روند فعالیت در بازه انتخابی</h2>
          <p className="mt-1 text-xs text-neutral-500">اقدام‌های مستقیم مدیران در کنار اجراهای خودکار</p>
        </figcaption>
        <div className="flex items-center gap-3 text-[11px] text-neutral-500">
          <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-indigo-500" />مدیران</span>
          <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-slate-400" />خودکار</span>
        </div>
      </div>
      {loading ? (
        <div className="h-36 animate-pulse rounded-xl bg-neutral-50 motion-reduce:animate-none" />
      ) : series.length === 0 ? (
        <div className="grid h-36 place-items-center rounded-xl bg-neutral-50 text-xs text-neutral-400">داده‌ای برای این بازه ثبت نشده است</div>
      ) : (
        <div className="flex h-36 items-end gap-1 overflow-hidden" role="img" aria-label="نمودار فعالیت مدیران و سامانه">
          {series.map((item) => {
            const humanHeight = Math.max(item.human ? 3 : 0, (item.human / maximum) * 100);
            const automaticHeight = Math.max(item.automatic ? 3 : 0, (item.automatic / maximum) * 100);
            return (
              <div key={item.date} className="flex h-full min-w-1 flex-1 items-end gap-px" title={`${item.date}: ${item.human} مدیر، ${item.automatic} خودکار`}>
                <span className="min-w-0 flex-1 rounded-t bg-indigo-500/85" style={{ height: `${humanHeight}%` }} />
                <span className="min-w-0 flex-1 rounded-t bg-slate-300" style={{ height: `${automaticHeight}%` }} />
              </div>
            );
          })}
        </div>
      )}
    </figure>
  );
}

function resultTone(result: AuditResult) {
  if (result === "failure" || result === "denied") return "bg-rose-50 text-rose-700";
  if (result === "partial" || result === "cancelled") return "bg-amber-50 text-amber-700";
  if (result === "queued") return "bg-blue-50 text-blue-700";
  if (result === "no_op") return "bg-neutral-100 text-neutral-600";
  return "bg-emerald-50 text-emerald-700";
}

function ActivityRow({ event, onOpen }: { event: AuditEvent; onOpen: () => void }) {
  const href = entityHref(event.target);
  const initials = principalLabel(event, event.mode === "human" ? "actor" : "initiator")
    .trim()
    .slice(0, 2);
  return (
    <article className="grid gap-3 px-3 py-4 transition hover:bg-neutral-50/70 motion-reduce:transition-none sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-start sm:px-4">
      <span className={`grid size-10 shrink-0 place-items-center rounded-full text-xs font-semibold ${event.mode === "human" ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"}`} aria-hidden>
        {event.mode === "human" ? initials || "مد" : <Bot className="size-4" />}
      </span>
      <div className="min-w-0">
        <button
          type="button"
          onClick={onOpen}
          className="block min-h-11 w-full rounded-md text-right text-sm font-medium leading-7 text-neutral-800 outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary"
        >
          {describeAuditEvent(event)}
        </button>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500">
          <span className={`rounded-md px-2 py-0.5 font-medium ${event.mode === "human" ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"}`}>
            {event.mode === "human" ? "اقدام مدیر" : ORIGIN_LABELS[event.origin]}
          </span>
          {event.mode === "automatic" && event.initiator.type === "human" && (
            <span>درخواست‌کننده: {principalLabel(event, "initiator")}</span>
          )}
          {href ? (
            <Link href={href} className="inline-flex min-h-6 items-center gap-1 text-infinity-primary hover:underline">
              {targetLabel(event.target)} <ExternalLink className="size-3" aria-hidden />
            </Link>
          ) : event.target ? (
            <span>{targetLabel(event.target)}</span>
          ) : null}
          {event.legacy && <span className="text-amber-600">اطلاعات انتساب قدیمی/ناشناخته</span>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end">
        <span className={`rounded-md px-2 py-1 text-[11px] font-medium ${resultTone(event.result)}`}>{RESULT_LABELS[event.result]}</span>
        <time dateTime={event.occurredAt} className="whitespace-nowrap text-[11px] text-neutral-400">{formatAuditTime(event.occurredAt)}</time>
      </div>
    </article>
  );
}

export default function AuditReport() {
  const state = useReportQueryState<FilterKey>({ extraKeys: FILTER_KEYS, tab: false });
  const { start, end, values, setFilter, setRange, setValues } = state;
  const mode = (["human", "automatic", "all"].includes(values.mode) ? values.mode : "human") as AuditMode;
  const [search, setSearch] = useState(values.q || "");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [options, setOptions] = useState<AuditFilterOptions>({ admins: [], sources: [], domains: [], eventKeys: [], targetTypes: [] });
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSearch(values.q || ""), [values.q]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (search.trim() !== (values.q || "")) setFilter("q", search.trim());
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, setFilter, values.q]);

  const range = useMemo(() => isoRange(start, end), [start, end]);
  const query = useMemo<AuditQuery>(() => ({
    ...range,
    mode,
    initiatorId: values.admin || undefined,
    origin: (values.origin || undefined) as AuditOrigin | undefined,
    domain: values.domain || undefined,
    eventKey: values.eventKey || undefined,
    targetType: values.targetType || undefined,
    targetId: values.targetId || undefined,
    result: (values.result || undefined) as AuditResult | undefined,
    importance: (values.importance || undefined) as AuditQuery["importance"],
    search: values.q || undefined,
    limit: 50,
  }), [mode, range, values.admin, values.domain, values.eventKey, values.importance, values.origin, values.q, values.result, values.targetId, values.targetType]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      getAuditEvents(query, controller.signal),
      getAuditSummary(query, controller.signal),
    ])
      .then(([page, nextSummary]) => {
        setEvents(page.items);
        setNextCursor(page.nextCursor);
        setHasMore(page.hasMore);
        setSummary(nextSummary);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setEvents([]);
        setSummary(null);
        setError(getUserFacingErrorMessage(cause, "دریافت گزارش فعالیت ناموفق بود"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    getAuditFilterOptions(range, controller.signal)
      .then(setOptions)
      .catch(() => setOptions({ admins: [], sources: [], domains: [], eventKeys: [], targetTypes: [] }));
    return () => controller.abort();
  }, [range]);

  useEffect(() => {
    if (!values.event) {
      setSelected(null);
      return;
    }
    const controller = new AbortController();
    getAuditEvent(values.event, controller.signal)
      .then(setSelected)
      .catch(() => {
        if (!controller.signal.aborted) setFilter("event", "");
      });
    return () => controller.abort();
  }, [setFilter, values.event]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getAuditEvents({ ...query, cursor: nextCursor });
      setEvents((current) => {
        const seen = new Set(current.map((event) => event.eventId));
        return [...current, ...page.items.filter((event) => !seen.has(event.eventId))];
      });
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, query]);

  const activeFilters = [values.admin, values.origin, values.domain, values.eventKey, values.targetType, values.targetId, values.result, values.importance, values.q].filter(Boolean).length;
  const clearFilters = useCallback(() => {
    const next: Record<string, string | null> = { page: "1" };
    FILTER_KEYS.forEach((key) => {
      if (key !== "mode" && key !== "event") next[key] = null;
    });
    void setValues(next);
  }, [setValues]);

  return (
    <ContentWrapper title="حسابرسی و فعالیت مدیران">
      <div className="space-y-5" dir="rtl">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="inline-flex w-full rounded-xl bg-neutral-100 p-1 lg:w-auto" aria-label="نوع فعالیت">
            {MODES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter("mode", value === "human" ? "" : value)}
                aria-pressed={mode === value}
                className={`inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary motion-reduce:transition-none sm:text-sm lg:flex-none ${mode === value ? "bg-white text-infinity-primary shadow-sm" : "text-neutral-600 hover:text-neutral-900"}`}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </button>
            ))}
          </div>
          <ReportExportButton onExport={() => downloadAuditExport(query)} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard title="کل فعالیت" value={summary?.total || 0} icon={CalendarClock} tone="bg-neutral-100 text-neutral-600" loading={loading} />
          <SummaryCard title="اقدام‌های مدیران" value={summary?.human || 0} detail={`${faNum(summary?.activeAdmins || 0)} مدیر فعال`} icon={UsersRound} tone="bg-indigo-50 text-indigo-700" loading={loading} />
          <SummaryCard title="اجراهای خودکار" value={summary?.automatic || 0} icon={Bot} tone="bg-slate-100 text-slate-600" loading={loading} />
          <SummaryCard title="ناموفق یا ردشده" value={summary?.failedOrDenied || 0} icon={AlertTriangle} tone="bg-rose-50 text-rose-700" loading={loading} />
        </div>

        <ActivitySplitChart summary={summary} loading={loading} />

        <section className="rounded-2xl border border-neutral-100 bg-white p-4 sm:p-5" aria-labelledby="audit-filters-heading">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 id="audit-filters-heading" className="text-sm font-semibold text-neutral-800">جست‌وجو و فیلترها</h2>
              <p className="mt-1 text-xs text-neutral-500">بر اساس مسئول، مبدأ، رویداد، نتیجه یا مورد اثرگرفته</p>
            </div>
            {activeFilters > 0 && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs font-medium text-neutral-600 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary"
              >
                <FilterX className="size-4" aria-hidden /> پاک‌کردن {faNum(activeFilters)} فیلتر
              </button>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="relative xl:col-span-2">
              <Search className="pointer-events-none absolute right-3 top-3.5 size-4 text-neutral-400" aria-hidden />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className={`${inputClass} pr-9`}
                placeholder="نام مدیر، سفارش، محصول، شناسه یا کد پیگیری…"
                aria-label="جست‌وجوی فعالیت‌ها"
              />
            </div>
            <select className={inputClass} value={values.admin} onChange={(event) => setFilter("admin", event.target.value)} aria-label="مدیر درخواست‌کننده">
              <option value="">همه مدیران</option>
              {options.admins.map((admin) => <option key={admin.id} value={admin.id}>{admin.label || `#${admin.id}`}{admin.role ? ` · ${admin.role}` : ""}</option>)}
            </select>
            <select className={inputClass} value={values.origin} onChange={(event) => setFilter("origin", event.target.value)} aria-label="مبدأ فعالیت">
              <option value="">همه مبدأها</option>
              {options.sources.map(({ value }) => <option key={value} value={value}>{ORIGIN_LABELS[value] || value}</option>)}
            </select>
            <select className={inputClass} value={values.domain} onChange={(event) => setFilter("domain", event.target.value)} aria-label="دسته رویداد">
              <option value="">همه دسته‌ها</option>
              {options.domains.map(({ value }) => <option key={value} value={value}>{DOMAIN_LABELS[value] || value}</option>)}
            </select>
            <select className={inputClass} value={values.eventKey} onChange={(event) => setFilter("eventKey", event.target.value)} aria-label="نوع رویداد">
              <option value="">همه رویدادها</option>
              {options.eventKeys.map(({ value }) => <option key={value} value={value}>{auditEventLabel(value)}</option>)}
            </select>
            <select className={inputClass} value={values.targetType} onChange={(event) => setFilter("targetType", event.target.value)} aria-label="نوع مورد اثرگرفته">
              <option value="">همه موارد</option>
              {options.targetTypes.map(({ value }) => <option key={value} value={value}>{auditTargetTypeLabel(value)}</option>)}
            </select>
            <select className={inputClass} value={values.result} onChange={(event) => setFilter("result", event.target.value)} aria-label="نتیجه رویداد">
              <option value="">همه نتیجه‌ها</option>
              {Object.entries(RESULT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <ReportDateRangeField
            className="mt-4 border-t border-neutral-100 pt-4"
            start={parseDateOnly(start) || new Date()}
            end={parseDateOnly(end) || new Date()}
            onChange={(next) => setRange({ start: toDateOnly(next.start), end: toDateOnly(next.end) })}
          />
        </section>

        <section className="overflow-hidden rounded-2xl border border-neutral-100 bg-white" aria-labelledby="audit-list-heading">
          <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-4 py-3">
            <div>
              <h2 id="audit-list-heading" className="text-sm font-semibold text-neutral-800">تازه‌ترین فعالیت‌ها</h2>
              <p className="mt-1 text-[11px] text-neutral-500">رویدادهای یک عملیات گروهی در یک ردیف اصلی جمع می‌شوند.</p>
            </div>
            <span className="text-xs text-neutral-400">{faNum(events.length)} ردیف نمایش‌داده‌شده</span>
          </div>

          {error ? (
            <div className="m-4 rounded-xl border border-rose-100 bg-rose-50 p-5 text-center">
              <p className="text-sm font-medium text-rose-700">{error}</p>
              <button type="button" onClick={() => window.location.reload()} className="mt-3 min-h-11 rounded-lg px-4 text-xs font-medium text-rose-700 hover:bg-rose-100">تلاش دوباره</button>
            </div>
          ) : loading ? (
            <div className="divide-y divide-neutral-100" aria-label="در حال دریافت فعالیت‌ها">
              {Array.from({ length: 7 }, (_, index) => <div key={index} className="h-24 animate-pulse bg-gradient-to-l from-neutral-50 to-white motion-reduce:animate-none" />)}
            </div>
          ) : events.length === 0 ? (
            <div className="grid min-h-64 place-items-center p-6 text-center">
              <div>
                <ShieldCheck className="mx-auto size-8 text-neutral-300" aria-hidden />
                <p className="mt-3 text-sm font-medium text-neutral-700">فعالیتی با این فیلترها پیدا نشد</p>
                <p className="mt-1 text-xs text-neutral-400">بازه زمانی یا فیلترهای انتخابی را تغییر دهید.</p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-neutral-100">
              {events.map((event) => (
                <ActivityRow key={event.eventId} event={event} onOpen={() => setFilter("event", event.eventId)} />
              ))}
            </div>
          )}

          {hasMore && !loading && (
            <div className="border-t border-neutral-100 p-3 text-center">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-medium text-infinity-primary transition hover:bg-infinity-primary/5 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary motion-reduce:transition-none"
              >
                <ChevronDown className="size-4" aria-hidden />
                {loadingMore ? "در حال دریافت…" : "نمایش فعالیت‌های بیشتر"}
              </button>
            </div>
          )}
        </section>

        <AuditEventDrawer event={selected} open={Boolean(values.event && selected)} onClose={() => setFilter("event", "")} />
      </div>
    </ContentWrapper>
  );
}
