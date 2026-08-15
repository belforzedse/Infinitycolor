"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpLeft, Bot, History } from "lucide-react";
import { useCan } from "@/hooks/useCan";
import { getAuditEvents, type AuditEvent, type AuditQuery } from "@/services/audit";
import AuditEventDrawer from "./AuditEventDrawer";
import {
  ORIGIN_LABELS,
  describeAuditEvent,
  formatAuditTime,
  principalLabel,
} from "./auditPresentation";

export type ContextualTimelineEvent = {
  id: number;
  message: string;
  createdAt: string;
  severity: "info" | "success" | "warning" | "error";
};

function severity(event: AuditEvent): ContextualTimelineEvent["severity"] {
  if (event.result === "failure") return "error";
  if (event.result === "denied" || event.result === "partial") return "warning";
  if (event.result === "success") return "success";
  return "info";
}

export default function AuditTimeline({
  title,
  targetType,
  targetId,
  query: extraQuery,
  pageSize = 20,
  hideHeader,
  onEventsChange,
}: {
  title: string;
  targetType?: string;
  targetId?: string | number;
  query?: Pick<AuditQuery, "initiatorId" | "eventKey" | "domain">;
  pageSize?: number;
  hideHeader?: boolean;
  onEventsChange?: (events: ContextualTimelineEvent[]) => void;
}) {
  const canReadAudit = useCan("system.audit.read");
  const [loadResult, setLoadResult] = useState<{
    queryKey: string;
    events: AuditEvent[];
    failed: boolean;
  } | null>(null);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const initiatorId = extraQuery?.initiatorId;
  const eventKey = extraQuery?.eventKey;
  const domain = extraQuery?.domain;

  const query = useMemo<AuditQuery>(() => ({
    mode: "all",
    targetType: targetType || undefined,
    targetId: targetId == null ? undefined : String(targetId),
    initiatorId,
    eventKey,
    domain,
    limit: Math.min(Math.max(pageSize, 1), 50),
  }), [domain, eventKey, initiatorId, pageSize, targetId, targetType]);
  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const isActive = canReadAudit && (targetId != null || Boolean(initiatorId));
  const isCurrentResult = isActive && loadResult?.queryKey === queryKey;
  const events = isCurrentResult ? loadResult.events : [];
  const loading = isActive && !isCurrentResult;
  const error = Boolean(isCurrentResult && loadResult.failed);

  const fullReportHref = useMemo(() => {
    const params = new URLSearchParams({ mode: "all" });
    if (targetType) params.set("targetType", targetType);
    if (targetId != null) params.set("targetId", String(targetId));
    if (initiatorId) params.set("admin", initiatorId);
    if (eventKey) params.set("eventKey", eventKey);
    if (domain) params.set("domain", domain);
    return `/sales/activity?${params.toString()}`;
  }, [domain, eventKey, initiatorId, targetId, targetType]);

  useEffect(() => {
    if (!isActive) {
      onEventsChange?.([]);
      return;
    }
    const controller = new AbortController();
    getAuditEvents(query, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setLoadResult({ queryKey, events: page.items, failed: false });
          onEventsChange?.(page.items.map((event) => ({
            id: event.id,
            message: describeAuditEvent(event),
            createdAt: event.occurredAt,
            severity: severity(event),
          })));
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLoadResult({ queryKey, events: [], failed: true });
        onEventsChange?.([]);
      });
    return () => controller.abort();
  }, [isActive, onEventsChange, query, queryKey]);

  if (!canReadAudit) return null;

  return (
    <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm" aria-labelledby={`audit-timeline-${targetType || "context"}`}>
      {!hideHeader && (
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 id={`audit-timeline-${targetType || "context"}`} className="text-foreground-primary text-base font-semibold">{title}</h2>
            <p className="mt-1 text-xs text-slate-500">اقدام‌های مدیران و اجراهای خودکار مرتبط</p>
          </div>
          <Link href={fullReportHref} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-xs font-medium text-infinity-primary hover:bg-infinity-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary">
            مشاهده همه <ArrowUpLeft className="size-3.5" aria-hidden />
          </Link>
        </div>
      )}
      {loading ? (
        <div className="space-y-3" aria-label="در حال دریافت سابقه">
          {Array.from({ length: 3 }, (_, index) => <div key={index} className="h-16 animate-pulse rounded-xl bg-slate-50 motion-reduce:animate-none" />)}
        </div>
      ) : error ? (
        <div className="text-sm text-rose-600">دریافت سابقه مدیریتی ناموفق بود.</div>
      ) : events.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl bg-slate-50 p-4 text-sm text-slate-500"><History className="size-4" aria-hidden />رویداد مدیریتی ثبت نشده است.</div>
      ) : (
        <ol className="relative space-y-1 border-r border-slate-200 pr-4">
          {events.map((event) => (
            <li key={event.eventId} className="relative py-2">
              <span className={`absolute -right-[22px] top-4 grid size-4 place-items-center rounded-full ring-4 ring-white ${event.mode === "human" ? "bg-indigo-500" : "bg-slate-400"}`} aria-hidden>
                {event.mode === "automatic" ? <Bot className="size-2.5 text-white" /> : null}
              </span>
              <button type="button" onClick={() => setSelected(event)} className="block min-h-11 w-full rounded-lg px-2 text-right outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-infinity-primary">
                <span className="block text-sm font-medium leading-6 text-slate-800">{describeAuditEvent(event)}</span>
                <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-slate-500">
                  <span>{formatAuditTime(event.occurredAt)}</span>
                  <span>{event.mode === "human" ? principalLabel(event, "actor") : ORIGIN_LABELS[event.origin]}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {hideHeader && !loading && events.length > 0 && (
        <Link href={fullReportHref} className="mt-3 inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-xs font-medium text-infinity-primary hover:bg-infinity-primary/5">مشاهده همه فعالیت‌ها <ArrowUpLeft className="size-3.5" aria-hidden /></Link>
      )}
      <AuditEventDrawer event={selected} open={Boolean(selected)} onClose={() => setSelected(null)} />
    </section>
  );
}
