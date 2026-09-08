"use client";

import {
  ArrowLeft,
  ArrowRight,
  Download,
  Inbox,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DatePicker } from "zaman";
import {
  parseDateOnly,
  toDateOnly,
} from "@/components/SuperAdmin/reports/shared/reportDates";

import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import {
  downloadIssueReports,
  listIssueReports,
  type IssueReportFilters,
  type IssueReportStatus,
  type IssueReportSummary,
} from "@/services/issue-reports";

import ReportDetails from "@/components/IssueReports/ReportDetails";
import {
  STATUS,
  StatusBadge,
  formatDate,
} from "@/components/IssueReports/shared";

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
            {[
              { value: from, setValue: setFrom, label: "از تاریخ" },
              { value: to, setValue: setTo, label: "تا تاریخ" },
            ].map(({ value, setValue, label }) => (
              <div key={label} className="min-w-0">
                <DatePicker
                  key={value || "empty"}
                  locale="fa"
                  direction="rtl"
                  defaultValue={value ? parseDateOnly(value) : undefined}
                  onChange={({ value: date }) => setValue(toDateOnly(date))}
                  inputAttributes={{ placeholder: label, "aria-label": label }}
                  inputClass="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
                />
              </div>
            ))}
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
