"use client";

import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
} from "@headlessui/react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Download,
  ExternalLink,
  Inbox,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { storefrontOrigin } from "@/config/admin-env";
import {
  downloadIssueReports,
  getIssueReport,
  listIssueReports,
  setIssueReportStatus,
  type IssueReportDetail,
  type IssueReportFilters,
  type IssueReportStatus,
  type IssueReportSummary,
} from "@/services/issue-reports";

const STATUS: Record<IssueReportStatus, { label: string; className: string }> =
  {
    new: { label: "جدید", className: "bg-sky-50 text-sky-700 ring-sky-200" },
    in_review: {
      label: "در حال بررسی",
      className: "bg-amber-50 text-amber-700 ring-amber-200",
    },
    resolved: {
      label: "رسیدگی‌شده",
      className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    },
  };

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function storefrontPage(path: string) {
  return new URL(path, storefrontOrigin()).toString();
}

function StatusBadge({ status }: { status: IssueReportStatus }) {
  const item = STATUS[status];
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${item.className}`}
    >
      {item.label}
    </span>
  );
}

function DetailRow({
  label,
  value,
  ltr = false,
}: {
  label: string;
  value: React.ReactNode;
  ltr?: boolean;
}) {
  return (
    <div className="grid gap-1 border-b border-slate-100 py-3 last:border-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd
        className="min-w-0 break-words text-sm font-medium text-slate-800"
        dir={ltr ? "ltr" : undefined}
      >
        {value || "—"}
      </dd>
    </div>
  );
}

function ReportDetails({
  reportId,
  onClose,
  onChanged,
}: {
  reportId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [report, setReport] = useState<IssueReportDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!reportId) return;
      setLoading(true);
      setError(null);
      try {
        setReport(await getIssueReport(reportId, signal));
      } catch (loadError) {
        if (!signal?.aborted)
          setError(
            loadError instanceof Error
              ? loadError.message
              : "دریافت گزارش انجام نشد.",
          );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [reportId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const changeStatus = async (status: IssueReportStatus) => {
    if (!report || report.status === status) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await setIssueReportStatus(
        report.reportId,
        status,
        report.version,
      );
      setReport(updated);
      onChanged();
    } catch (saveError: unknown) {
      const status =
        typeof saveError === "object" && saveError && "status" in saveError
          ? Number((saveError as { status?: unknown }).status)
          : null;
      if (status === 409) await load();
      setError(
        saveError instanceof Error
          ? saveError.message
          : "تغییر وضعیت انجام نشد.",
      );
    } finally {
      setSaving(false);
    }
  };

  const context = report?.clientContext;
  return (
    <Dialog
      open={Boolean(reportId)}
      onClose={onClose}
      className="relative z-[100]"
      dir="rtl"
    >
      <DialogBackdrop className="fixed inset-0 bg-slate-950/35 transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none" />
      <div className="fixed inset-0 overflow-hidden">
        <div className="absolute inset-0 overflow-hidden">
          <div className="pointer-events-none fixed inset-y-0 left-0 flex max-w-full pl-0 sm:pl-6">
            <DialogPanel className="pointer-events-auto h-full w-screen max-w-2xl overflow-y-auto bg-white shadow-2xl transition duration-200 data-[closed]:-translate-x-full motion-reduce:transition-none">
              <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur sm:px-7">
                <DialogTitle className="text-lg font-bold text-slate-900">
                  جزئیات گزارش
                </DialogTitle>
                <button
                  type="button"
                  onClick={onClose}
                  className="grid h-10 w-10 place-items-center rounded-full text-slate-500 hover:bg-slate-100"
                  aria-label="بستن"
                >
                  <X className="h-5 w-5" />
                </button>
              </header>

              <div className="p-5 sm:p-7">
                {loading ? (
                  <div className="grid min-h-72 place-items-center">
                    <Loader2
                      className="h-7 w-7 animate-spin text-slate-400"
                      aria-label="در حال بارگذاری"
                    />
                  </div>
                ) : error && !report ? (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
                    <p>{error}</p>
                    <button
                      type="button"
                      onClick={() => void load()}
                      className="mt-3 font-semibold underline"
                    >
                      تلاش دوباره
                    </button>
                  </div>
                ) : report ? (
                  <div className="space-y-6">
                    <section>
                      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                        <h2 className="text-xl font-bold leading-8 text-slate-900">
                          {report.issueName}
                        </h2>
                        <StatusBadge status={report.status} />
                      </div>
                      <p className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm leading-7 text-slate-700">
                        {report.description}
                      </p>
                    </section>

                    <section className="rounded-2xl border border-slate-200 p-4">
                      <h3 className="mb-2 font-bold text-slate-900">پیگیری</h3>
                      <label className="block text-sm text-slate-600">
                        وضعیت
                        <select
                          value={report.status}
                          disabled={saving}
                          onChange={(event) =>
                            void changeStatus(
                              event.target.value as IssueReportStatus,
                            )
                          }
                          className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-slate-800 disabled:opacity-60"
                        >
                          {Object.entries(STATUS).map(([value, item]) => (
                            <option key={value} value={value}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {saving && (
                        <p className="mt-2 inline-flex items-center gap-2 text-xs text-slate-500">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          در حال ذخیره...
                        </p>
                      )}
                      {error && (
                        <p className="mt-2 text-sm text-rose-600" role="alert">
                          {error}
                        </p>
                      )}
                    </section>

                    <section>
                      <h3 className="mb-2 font-bold text-slate-900">
                        اطلاعات گزارش
                      </h3>
                      <dl className="rounded-2xl border border-slate-200 px-4">
                        <DetailRow
                          label="شماره تماس"
                          value={
                            <a
                              className="text-blue-700 hover:underline"
                              href={`tel:${report.contactNumber}`}
                            >
                              {report.contactNumber}
                            </a>
                          }
                          ltr
                        />
                        <DetailRow
                          label="زمان ثبت"
                          value={formatDate(report.submittedAt)}
                        />
                        <DetailRow
                          label="صفحه"
                          value={
                            report.sourcePath ? (
                              <a
                                className="inline-flex items-center gap-1 text-blue-700 hover:underline"
                                dir="ltr"
                                href={storefrontPage(report.sourcePath)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {report.sourcePath}
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : (
                              "—"
                            )
                          }
                        />
                        <DetailRow
                          label="شناسه گزارش"
                          value={report.reportId}
                          ltr
                        />
                        <DetailRow
                          label="حساب کاربری"
                          value={
                            report.reporterUserId
                              ? `#${report.reporterUserId}`
                              : "مهمان"
                          }
                        />
                      </dl>
                    </section>

                    <section>
                      <h3 className="mb-2 flex items-center gap-2 font-bold text-slate-900">
                        <MonitorSmartphone className="h-5 w-5" />
                        اطلاعات فنی
                      </h3>
                      <dl className="rounded-2xl border border-slate-200 px-4">
                        <DetailRow
                          label="زمان دستگاه"
                          value={formatDate(context?.clientTime)}
                        />
                        <DetailRow
                          label="منطقه زمانی"
                          value={context?.timeZone}
                          ltr
                        />
                        <DetailRow label="زبان" value={context?.language} ltr />
                        <DetailRow
                          label="پنجره مرورگر"
                          value={
                            context?.viewport
                              ? `${context.viewport.width} × ${context.viewport.height}`
                              : null
                          }
                          ltr
                        />
                        <DetailRow
                          label="صفحه‌نمایش"
                          value={
                            context?.screen
                              ? `${context.screen.width} × ${context.screen.height} · ${context.screen.pixelRatio}x`
                              : null
                          }
                          ltr
                        />
                        <DetailRow
                          label="اتصال"
                          value={
                            context?.online == null
                              ? null
                              : context.online
                                ? `آنلاین${context.connectionType ? ` · ${context.connectionType}` : ""}`
                                : "آفلاین"
                          }
                        />
                        <DetailRow
                          label="مرورگر و دستگاه"
                          value={report.userAgent}
                          ltr
                        />
                      </dl>
                    </section>
                  </div>
                ) : null}
              </div>
            </DialogPanel>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export default function IssueReportsPage() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<IssueReportStatus | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [items, setItems] = useState<IssueReportSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      350,
    );
    return () => window.clearTimeout(timer);
  }, [search]);

  const filters = useMemo<IssueReportFilters>(
    () => ({
      search: debouncedSearch || undefined,
      status: status || undefined,
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
    }),
    [debouncedSearch, from, status, to],
  );

  useEffect(() => setCursorHistory([]), [debouncedSearch, status, from, to]);
  const cursor = cursorHistory.at(-1);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    listIssueReports({ ...filters, cursor, limit: 25 }, controller.signal)
      .then((result) => {
        setItems(result.items);
        setNextCursor(result.nextCursor);
      })
      .catch((loadError) => {
        if (!controller.signal.aborted)
          setError(
            loadError instanceof Error
              ? loadError.message
              : "دریافت گزارش‌ها انجام نشد.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cursor, filters, revision]);

  const clearFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setStatus("");
    setFrom("");
    setTo("");
    setCursorHistory([]);
  };

  const exportRows = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await downloadIssueReports(filters);
    } catch (downloadError) {
      setExportError(
        downloadError instanceof Error
          ? downloadError.message
          : "دریافت خروجی انجام نشد.",
      );
    } finally {
      setExporting(false);
    }
  };

  const hasFilters = Boolean(search || status || from || to);
  return (
    <ContentWrapper title="گزارش مشکلات">
      <div className="space-y-4" dir="rtl">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="grid gap-3 lg:grid-cols-[minmax(15rem,1fr)_11rem_10rem_10rem_auto]">
            <label className="relative block">
              <span className="sr-only">جست‌وجو</span>
              <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="شناسه، شماره تماس یا عنوان"
                className="min-h-11 w-full rounded-xl border border-slate-300 bg-white pr-10 pl-3 text-sm outline-none focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/15"
                inputMode="search"
              />
            </label>
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as IssueReportStatus | "")
              }
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm"
            >
              <option value="">همه وضعیت‌ها</option>
              {Object.entries(STATUS).map(([value, item]) => (
                <option key={value} value={value}>
                  {item.label}
                </option>
              ))}
            </select>
            <label className="relative">
              <span className="sr-only">از تاریخ</span>
              <CalendarDays className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-slate-300 bg-white pr-9 pl-2 text-sm"
                title="از تاریخ"
              />
            </label>
            <label className="relative">
              <span className="sr-only">تا تاریخ</span>
              <CalendarDays className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-slate-300 bg-white pr-9 pl-2 text-sm"
                title="تا تاریخ"
              />
            </label>
            <button
              type="button"
              onClick={() => void exportRows()}
              disabled={exporting}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-infinity-primary px-4 text-sm font-semibold text-white disabled:opacity-60"
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              خروجی اکسل
            </button>
          </div>
          {(hasFilters || exportError) && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-slate-500 hover:text-slate-800"
                >
                  پاک کردن فیلترها
                </button>
              )}
              {exportError && (
                <p className="text-rose-600" role="alert">
                  {exportError}
                </p>
              )}
            </div>
          )}
        </section>

        {error ? (
          <section className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center text-rose-700">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => setRevision((value) => value + 1)}
              className="mt-3 inline-flex items-center gap-2 font-semibold underline"
            >
              <RefreshCw className="h-4 w-4" />
              تلاش دوباره
            </button>
          </section>
        ) : loading ? (
          <div className="space-y-2" aria-label="در حال بارگذاری">
            {[0, 1, 2, 3, 4].map((item) => (
              <div
                key={item}
                className="h-20 animate-pulse rounded-2xl bg-slate-100"
              />
            ))}
          </div>
        ) : items.length === 0 ? (
          <section className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
            <div>
              <Inbox className="mx-auto mb-3 h-10 w-10 text-slate-300" />
              <p className="font-semibold text-slate-700">گزارشی پیدا نشد.</p>
            </div>
          </section>
        ) : (
          <>
            <div className="grid gap-3 md:hidden">
              {items.map((report) => (
                <button
                  key={report.reportId}
                  type="button"
                  onClick={() => setSelected(report.reportId)}
                  className="rounded-2xl border border-slate-200 bg-white p-4 text-right shadow-sm transition hover:border-slate-300 motion-reduce:transition-none"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="font-bold text-slate-900">
                      {report.issueName}
                    </h2>
                    <StatusBadge status={report.status} />
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">
                    {report.descriptionPreview}
                  </p>
                  <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
                    <span dir="ltr">{report.contactNumber}</span>
                    <span>{formatDate(report.submittedAt)}</span>
                  </div>
                </button>
              ))}
            </div>

            <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm md:block">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-right text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">عنوان</th>
                      <th className="px-4 py-3 font-semibold">شماره تماس</th>
                      <th className="px-4 py-3 font-semibold">وضعیت</th>
                      <th className="px-4 py-3 font-semibold">زمان ثبت</th>
                      <th className="w-20 px-4 py-3">
                        <span className="sr-only">مشاهده</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((report) => (
                      <tr
                        key={report.reportId}
                        className="hover:bg-slate-50/80"
                      >
                        <td className="max-w-xl px-4 py-4">
                          <button
                            type="button"
                            onClick={() => setSelected(report.reportId)}
                            className="text-right"
                          >
                            <span className="block font-semibold text-slate-900">
                              {report.issueName}
                            </span>
                            <span className="mt-1 block max-w-xl truncate text-xs text-slate-500">
                              {report.descriptionPreview}
                            </span>
                          </button>
                        </td>
                        <td
                          className="px-4 py-4 font-medium text-slate-700"
                          dir="ltr"
                        >
                          {report.contactNumber}
                        </td>
                        <td className="px-4 py-4">
                          <StatusBadge status={report.status} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-4 text-slate-600">
                          {formatDate(report.submittedAt)}
                        </td>
                        <td className="px-4 py-4">
                          <button
                            type="button"
                            onClick={() => setSelected(report.reportId)}
                            className="inline-flex min-h-10 items-center gap-1 rounded-lg px-3 text-sm font-semibold text-blue-700 hover:bg-blue-50"
                          >
                            مشاهده
                            <ArrowLeft className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {!error && !loading && items.length > 0 && (
          <nav
            className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-3"
            aria-label="صفحه‌بندی گزارش‌ها"
          >
            <button
              type="button"
              disabled={cursorHistory.length === 0}
              onClick={() =>
                setCursorHistory((history) => history.slice(0, -1))
              }
              className="inline-flex min-h-10 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40"
            >
              <ArrowRight className="h-4 w-4" />
              قبلی
            </button>
            <span className="text-xs text-slate-500">
              صفحه {cursorHistory.length + 1}
            </span>
            <button
              type="button"
              disabled={!nextCursor}
              onClick={() =>
                nextCursor &&
                setCursorHistory((history) => [...history, nextCursor])
              }
              className="inline-flex min-h-10 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40"
            >
              بعدی
              <ArrowLeft className="h-4 w-4" />
            </button>
          </nav>
        )}
      </div>

      <ReportDetails
        reportId={selected}
        onClose={() => setSelected(null)}
        onChanged={() => setRevision((value) => value + 1)}
      />
    </ContentWrapper>
  );
}
