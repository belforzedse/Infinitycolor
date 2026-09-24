"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import Link from "next/link";
import { Check, Copy, ExternalLink, X } from "lucide-react";
import {
  getRelatedAuditEvents,
  type AuditEvent,
} from "@/services/audit";
import {
  ACTOR_LABELS,
  ORIGIN_LABELS,
  RESULT_LABELS,
  describeAuditEvent,
  entityHref,
  formatAuditTime,
  formatAuditValue,
  principalLabel,
  targetLabel,
} from "./auditPresentation";

function CopyValue({ value, label }: { value?: string | null; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2">
      <div className="min-w-0">
        <dt className="text-[11px] text-neutral-500">{label}</dt>
        <dd className="mt-1 truncate font-mono text-xs text-neutral-700" dir="ltr" title={value}>
          {value}
        </dd>
      </div>
      <button
        type="button"
        className="grid size-11 shrink-0 place-items-center rounded-lg text-neutral-500 transition hover:bg-white hover:text-infinity-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary motion-reduce:transition-none"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        }}
        aria-label={`کپی ${label}`}
      >
        {copied ? <Check className="size-4 text-emerald-600" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      </button>
    </div>
  );
}

function PartyCard({ event, kind }: { event: AuditEvent; kind: "actor" | "initiator" }) {
  const party = event[kind];
  const same = event.actor.type === event.initiator.type && String(event.actor.id || "") === String(event.initiator.id || "");
  return (
    <div className="rounded-xl border border-neutral-100 bg-neutral-50/70 p-3">
      <p className="text-[11px] font-medium text-neutral-500">
        {kind === "actor" ? "عامل مستقیم (Actor)" : "درخواست‌کننده اصلی (Initiator)"}
      </p>
      <p className="mt-1 text-sm font-semibold text-neutral-800">{principalLabel(event, kind)}</p>
      <p className="mt-1 text-xs text-neutral-500">
        {ACTOR_LABELS[party.type]}
        {party.role ? ` · نقش هنگام رویداد: ${party.role}` : ""}
        {kind === "initiator" && same ? " · همان عامل مستقیم" : ""}
      </p>
    </div>
  );
}

export default function AuditEventDrawer({
  event,
  open,
  onClose,
}: {
  event: AuditEvent | null;
  open: boolean;
  onClose: () => void;
}) {
  const [relatedResult, setRelatedResult] = useState<{
    eventId: string;
    items: AuditEvent[];
  } | null>(null);
  const targetHref = event ? entityHref(event.target) : null;
  const related = event && relatedResult?.eventId === event.eventId ? relatedResult.items : [];
  const relatedLoading = Boolean(open && event && relatedResult?.eventId !== event.eventId);
  const advanced = useMemo(() => {
    if (!event) return null;
    return {
      eventKey: event.eventKey,
      schemaVersion: event.schemaVersion,
      environment: event.environment,
      service: event.service,
      reasonCode: event.reasonCode,
      metadata: event.metadata,
      scope: event.scope,
    };
  }, [event]);

  useEffect(() => {
    if (!open || !event) return;
    const controller = new AbortController();
    getRelatedAuditEvents(event.eventId, { limit: 20, includeChildren: true }, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setRelatedResult({
            eventId: event.eventId,
            items: page.items.filter((item) => item.eventId !== event.eventId),
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setRelatedResult({ eventId: event.eventId, items: [] });
        }
      });
    return () => controller.abort();
  }, [event, open]);

  return (
    <Transition show={open} as={Fragment}>
      <Dialog as="div" className="relative z-[1300]" onClose={onClose} dir="rtl">
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-[180ms] motion-reduce:transition-none"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-[160ms] motion-reduce:transition-none"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-slate-950/35 backdrop-blur-[1px]" aria-hidden />
        </Transition.Child>

        <div className="fixed inset-0 flex justify-end overflow-hidden">
          <Transition.Child
            as={Fragment}
            enter="transform transition ease-out duration-[180ms] motion-reduce:transition-none"
            enterFrom="translate-x-full"
            enterTo="translate-x-0"
            leave="transform transition ease-in duration-[160ms] motion-reduce:transition-none"
            leaveFrom="translate-x-0"
            leaveTo="translate-x-full"
          >
            <Dialog.Panel className="flex h-full w-full max-w-2xl flex-col border-r border-neutral-200 bg-white shadow-2xl">
              <div className="flex items-start justify-between gap-4 border-b border-neutral-100 px-4 py-4 sm:px-6">
                <div className="min-w-0">
                  <Dialog.Title className="text-base font-semibold text-neutral-900">
                    جزئیات رویداد
                  </Dialog.Title>
                  {event && (
                    <p className="mt-1 text-xs text-neutral-500">
                      {formatAuditTime(event.occurredAt)} · {RESULT_LABELS[event.result]}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="grid size-11 shrink-0 place-items-center rounded-xl text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary motion-reduce:transition-none"
                  aria-label="بستن جزئیات رویداد"
                >
                  <X className="size-5" aria-hidden />
                </button>
              </div>

              {event ? (
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
                  <div className="space-y-6">
                    <section aria-labelledby="audit-summary-heading">
                      <h2 id="audit-summary-heading" className="sr-only">خلاصه رویداد</h2>
                      <p className="text-base font-medium leading-8 text-neutral-900">
                        {describeAuditEvent(event)}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs">
                        <span className={`rounded-md px-2 py-1 font-medium ${event.mode === "human" ? "bg-infinity-primary/10 text-infinity-primary" : "bg-slate-100 text-slate-700"}`}>
                          {event.mode === "human" ? "اقدام مدیر" : "اجرای خودکار"}
                        </span>
                        <span className="rounded-md bg-neutral-100 px-2 py-1 text-neutral-600">
                          {ORIGIN_LABELS[event.origin]}
                        </span>
                        <span className={`rounded-md px-2 py-1 font-medium ${event.result === "failure" || event.result === "denied" ? "bg-rose-50 text-rose-700" : event.result === "partial" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
                          {RESULT_LABELS[event.result]}
                        </span>
                        {event.legacy && (
                          <span className="rounded-md bg-amber-50 px-2 py-1 text-amber-700">سابقه قدیمی</span>
                        )}
                      </div>
                    </section>

                    <section aria-labelledby="audit-attribution-heading">
                      <h2 id="audit-attribution-heading" className="mb-3 text-sm font-semibold text-neutral-800">
                        مسئولیت و مسیر آغاز
                      </h2>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <PartyCard event={event} kind="actor" />
                        <PartyCard event={event} kind="initiator" />
                      </div>
                      <p className="mt-3 text-xs leading-6 text-neutral-500">
                        مبدأ: {ORIGIN_LABELS[event.origin]}
                        {event.route ? ` · مسیر ${event.route}` : ""}
                        {event.httpMethod ? ` · ${event.httpMethod}` : ""}
                      </p>
                    </section>

                    {event.target && (
                      <section aria-labelledby="audit-target-heading">
                        <h2 id="audit-target-heading" className="mb-3 text-sm font-semibold text-neutral-800">
                          مورد اثرگرفته
                        </h2>
                        <div className="flex items-center justify-between gap-3 rounded-xl border border-neutral-100 bg-neutral-50/70 p-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-neutral-800">{targetLabel(event.target)}</p>
                            <p className="mt-1 font-mono text-xs text-neutral-500" dir="ltr">
                              {event.target.type}{event.target.id != null ? ` · ${event.target.id}` : ""}
                            </p>
                          </div>
                          {targetHref && (
                            <Link
                              href={targetHref}
                              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-3 text-xs font-medium text-infinity-primary transition hover:bg-infinity-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary motion-reduce:transition-none"
                            >
                              مشاهده
                              <ExternalLink className="size-3.5" aria-hidden />
                            </Link>
                          )}
                        </div>
                      </section>
                    )}

                    {event.changes.length > 0 && (
                      <section aria-labelledby="audit-changes-heading">
                        <h2 id="audit-changes-heading" className="mb-3 text-sm font-semibold text-neutral-800">
                          تغییرات
                        </h2>
                        <div className="overflow-hidden rounded-xl border border-neutral-100">
                          {event.changes.map((change, index) => (
                            <div key={`${change.field}-${index}`} className="grid gap-2 border-b border-neutral-100 p-3 last:border-b-0 sm:grid-cols-[minmax(110px,0.6fr)_1fr_auto_1fr] sm:items-center">
                              <p className="text-xs font-medium text-neutral-700">{change.label || change.field}</p>
                              <p className="min-w-0 break-words rounded-md bg-rose-50/70 px-2 py-1.5 text-xs text-neutral-600 line-through">
                                {formatAuditValue(change.from)}
                              </p>
                              <span className="hidden text-neutral-300 sm:inline" aria-hidden>←</span>
                              <p className="min-w-0 break-words rounded-md bg-emerald-50/70 px-2 py-1.5 text-xs font-medium text-neutral-800">
                                {formatAuditValue(change.to)}
                              </p>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}

                    {(relatedLoading || related.length > 0) && (
                      <section aria-labelledby="audit-related-heading">
                        <h2 id="audit-related-heading" className="mb-3 text-sm font-semibold text-neutral-800">
                          رویدادهای همین عملیات
                        </h2>
                        {relatedLoading ? (
                          <div className="space-y-2" aria-label="در حال دریافت رویدادهای مرتبط">
                            <div className="h-12 animate-pulse rounded-lg bg-neutral-100 motion-reduce:animate-none" />
                            <div className="h-12 animate-pulse rounded-lg bg-neutral-100 motion-reduce:animate-none" />
                          </div>
                        ) : (
                          <ol className="space-y-2">
                            {related.map((item) => (
                              <li key={item.eventId} className="rounded-lg border border-neutral-100 px-3 py-2">
                                <p className="text-xs font-medium leading-6 text-neutral-700">{describeAuditEvent(item)}</p>
                                <p className="mt-1 text-[11px] text-neutral-400">{formatAuditTime(item.occurredAt)}</p>
                              </li>
                            ))}
                          </ol>
                        )}
                      </section>
                    )}

                    <section aria-labelledby="audit-identifiers-heading">
                      <h2 id="audit-identifiers-heading" className="mb-3 text-sm font-semibold text-neutral-800">
                        شناسه‌های پیگیری
                      </h2>
                      <dl className="grid gap-2 sm:grid-cols-2">
                        <CopyValue label="شناسه رویداد" value={event.eventId} />
                        <CopyValue label="شناسه هم‌بستگی" value={event.correlationId} />
                        <CopyValue label="شناسه درخواست" value={event.requestId} />
                        <CopyValue label="شناسه کار صف" value={event.jobId} />
                        <CopyValue label="شناسه دسته" value={event.batchId} />
                        <CopyValue label="نشانی IP" value={event.ip} />
                      </dl>
                      <p className="mt-3 text-xs text-neutral-500">
                        زمان وقوع (UTC): <span className="font-mono" dir="ltr">{event.occurredAt}</span>
                        {event.recordedAt !== event.occurredAt && (
                          <> · زمان ثبت: <span className="font-mono" dir="ltr">{event.recordedAt}</span></>
                        )}
                      </p>
                    </section>

                    <details className="rounded-xl border border-neutral-100 bg-neutral-50/50 p-3">
                      <summary className="cursor-pointer select-none text-sm font-medium text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary">
                        جزئیات فنی و داده پاک‌سازی‌شده
                      </summary>
                      <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-950 p-3 text-left font-mono text-[11px] leading-5 text-slate-200" dir="ltr">
                        {JSON.stringify(advanced, null, 2)}
                      </pre>
                    </details>
                  </div>
                </div>
              ) : null}
            </Dialog.Panel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition>
  );
}
