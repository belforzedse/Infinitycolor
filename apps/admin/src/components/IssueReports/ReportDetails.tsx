"use client";

import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
} from "@headlessui/react";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  MonitorSmartphone,
  Smartphone,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { storefrontOrigin } from "@/config/admin-env";
import {
  getIssueReport,
  setIssueReportStatus,
  type IssueReportDetail,
  type IssueReportStatus,
} from "@/services/issue-reports";
import { faNum } from "@/utils/faNum";
import { translateOrderStatus, translatePaymentGateway } from "@/utils/statusTranslations";
import { describeDevice } from "./device";
import { STATUS } from "./shared";

type Props = {
  reportId: string | null;
  onClose: () => void;
  onChanged: () => void;
};

function dateText(value: string | null | undefined) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "—";
  const date = new Date(value);
  return `${new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium" }).format(date)}، ساعت ${new Intl.DateTimeFormat("fa-IR", { timeStyle: "short" }).format(date)}`;
}

function Row({
  label,
  children,
  ltr = false,
}: {
  label: string;
  children: ReactNode;
  ltr?: boolean;
}) {
  return (
    <div className="grid gap-2 border-b border-slate-100 py-3 last:border-0 sm:grid-cols-[7rem_minmax(0,1fr)]">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd
        dir={ltr ? "ltr" : undefined}
        className="min-w-0 text-sm font-medium leading-6 text-slate-800 [overflow-wrap:anywhere]"
      >
        {children ?? "—"}
      </dd>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <button
        type="button"
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
        className="grid h-11 w-11 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
      >
        {state === "copied" ? (
          <Check className="h-4 w-4 text-emerald-600" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
      <span
        role="status"
        className={state === "failed" ? "text-xs text-rose-600" : "sr-only"}
      >
        {state === "copied"
          ? "کپی شد"
          : state === "failed"
            ? "کپی انجام نشد"
            : ""}
      </span>
    </span>
  );
}

export default function ReportDetails(props: Props) {
  return (
    <Dialog
      open={Boolean(props.reportId)}
      onClose={props.onClose}
      className="relative z-[100]"
      dir="rtl"
    >
      <DialogBackdrop className="fixed inset-0 bg-slate-950/35" />
      <div className="pointer-events-none fixed inset-y-0 left-0 flex max-w-full sm:pl-6">
        <DialogPanel className="pointer-events-auto h-full w-screen max-w-2xl overflow-y-auto bg-white shadow-2xl">
          <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur sm:px-7">
            <DialogTitle className="text-lg font-bold text-slate-900">
              جزئیات گزارش
            </DialogTitle>
            <button
              type="button"
              onClick={props.onClose}
              className="grid h-11 w-11 place-items-center rounded-full text-slate-500 hover:bg-slate-100"
              aria-label="بستن"
            >
              <X className="h-5 w-5" />
            </button>
          </header>
          {props.reportId && (
            <ReportContent
              key={props.reportId}
              reportId={props.reportId}
              onChanged={props.onChanged}
            />
          )}
        </DialogPanel>
      </div>
    </Dialog>
  );
}

function ReportContent({
  reportId,
  onChanged,
}: {
  reportId: string;
  onChanged: () => void;
}) {
  const [report, setReport] = useState<IssueReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    getIssueReport(reportId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setReport(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("دریافت گزارش انجام نشد. دوباره تلاش کنید.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reportId, revision]);

  async function changeStatus(status: IssueReportStatus) {
    if (!report || saving || status === report.status) return;
    setSaving(true);
    setError("");
    try {
      const updated = await setIssueReportStatus(
        reportId,
        status,
        report.version,
      );
      if (!alive.current) return;
      setReport(updated);
      onChanged();
    } catch (failure) {
      if (!alive.current) return;
      if (
        typeof failure === "object" &&
        failure &&
        "status" in failure &&
        Number(failure.status) === 409
      ) {
        try {
          const updated = await getIssueReport(reportId);
          if (!alive.current) return;
          setReport(updated);
          onChanged();
          setError(
            "وضعیت گزارش تغییر کرده بود. اطلاعات به‌روز شد؛ دوباره انتخاب کنید.",
          );
        } catch {
          if (alive.current) {
            setReport(null);
            setError("دریافت وضعیت جدید انجام نشد. دوباره تلاش کنید.");
          }
        }
      } else setError("تغییر وضعیت انجام نشد. دوباره تلاش کنید.");
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  if (loading)
    return (
      <div
        role="status"
        className="flex min-h-72 items-center justify-center gap-2 text-sm text-slate-500"
      >
        <Loader2 className="h-5 w-5 animate-spin" />
        در حال دریافت گزارش…
      </div>
    );
  if (!report)
    return (
      <div className="m-5 rounded-xl bg-rose-50 p-5 text-sm text-rose-700">
        <p role="alert">{error}</p>
        <button
          type="button"
          onClick={() => setRevision((value) => value + 1)}
          className="mt-3 min-h-11 font-semibold underline"
        >
          تلاش دوباره
        </button>
      </div>
    );
  const context = report.clientContext;
  const device = describeDevice(report.userAgent, context?.androidHints);
  const page = report.sourcePath
    ? new URL(report.sourcePath, storefrontOrigin()).toString()
    : null;
  return (
    <div className="space-y-6 p-5 sm:p-7">
      <section className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-xl font-bold leading-8 text-slate-900">
              {report.issueName}
            </h2>
            <p className="mt-1 text-xs leading-6 text-slate-500">
              {dateText(report.submittedAt)}
            </p>
          </div>
          <label className="shrink-0">
            <span className="sr-only">وضعیت</span>
            <select
              aria-label="وضعیت"
              value={report.status}
              disabled={saving}
              onChange={(event) =>
                void changeStatus(event.target.value as IssueReportStatus)
              }
              className={`min-h-11 rounded-xl border-0 px-3 text-sm font-semibold ring-1 ring-inset disabled:opacity-60 ${STATUS[report.status].className}`}
            >
              {Object.entries(STATUS).map(([value, item]) => (
                <option key={value} value={value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {saving && (
          <p
            role="status"
            className="flex items-center gap-2 text-xs text-slate-500"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            در حال ذخیره…
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700"
          >
            {error}
          </p>
        )}
        <p className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm leading-8 text-slate-700 [overflow-wrap:anywhere]">
          {report.description}
        </p>
      </section>
      <section>
        <h3 className="mb-3 font-bold text-slate-900">دستگاه و مرورگر</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            {
              label: "دستگاه",
              value: device.device,
              note: device.deviceNote,
              Icon: Smartphone,
            },
            {
              label: "سیستم‌عامل",
              value: device.os,
              note: device.osNote,
              Icon: MonitorSmartphone,
            },
            {
              label: "مرورگر",
              value: device.browser,
              note: undefined,
              Icon: Globe,
            },
          ].map(({ label, value, note, Icon }) => (
            <div
              key={label}
              className="min-w-0 rounded-2xl border border-slate-200 p-4"
            >
              <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
                <Icon className="h-4 w-4" />
                {label}
              </div>
              <p
                dir="auto"
                className="text-start text-sm font-semibold leading-6 text-slate-900 [overflow-wrap:anywhere]"
              >
                {value}
              </p>
              {note && (
                <p className="mt-2 text-xs leading-5 text-slate-500">{note}</p>
              )}
            </div>
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-2 font-bold text-slate-900">اطلاعات گزارش</h3>
        <dl className="rounded-2xl border border-slate-200 px-4">
          <Row label="شماره تماس" ltr>
            <a
              href={`tel:${report.contactNumber}`}
              className="text-blue-700 hover:underline"
            >
              {report.contactNumber}
            </a>
          </Row>
          <Row label="حساب کاربری">
            {report.reporterUserId ? (
              <bdi>#{report.reporterUserId}</bdi>
            ) : (
              "مهمان"
            )}
          </Row>
          <Row label="صفحه" ltr>
            {page ? (
              <div className="flex items-center justify-between gap-2">
                <a
                  href={page}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 text-blue-700 hover:underline"
                >
                  {report.sourcePath}
                  <ExternalLink className="ml-1 inline h-3.5 w-3.5" />
                </a>
                <CopyButton value={page} label="کپی نشانی صفحه" />
              </div>
            ) : (
              "—"
            )}
          </Row>
          <Row label="شناسه گزارش" ltr>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 font-mono text-xs">
                {report.reportId}
              </span>
              <CopyButton value={report.reportId} label="کپی شناسه گزارش" />
            </div>
          </Row>
        </dl>
      </section>
      {(report.order || (context?.cart && context.cart.length > 0)) && (
        <section>
          <h3 className="mb-2 font-bold text-slate-900">خرید</h3>
          {report.order ? (
            <div className="space-y-3 rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  href={`/orders/edit/${report.order.id}`}
                  className="font-semibold text-blue-700 hover:underline"
                >
                  سفارش #{report.order.id}
                </Link>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>{translateOrderStatus(report.order.status)}</span>
                  {report.order.paymentGateway && (
                    <>
                      <span>·</span>
                      <span>{translatePaymentGateway(report.order.paymentGateway)}</span>
                    </>
                  )}
                </div>
              </div>
              {report.order.reporterMatchesOrder === false && (
                <p
                  role="alert"
                  className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800"
                >
                  این سفارش به حساب کاربری گزارش‌دهنده تعلق ندارد.
                </p>
              )}
              <ul className="divide-y divide-slate-100">
                {report.order.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-900">
                        {item.productTitle}
                      </p>
                      <p className="text-xs text-slate-500" dir="ltr">
                        {item.productSku}
                      </p>
                    </div>
                    <div className="shrink-0 text-left text-xs text-slate-600">
                      <p>{faNum(item.count)} عدد</p>
                      <p>{faNum(item.perAmount)} تومان</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200 p-4">
              <p className="mb-2 text-xs text-slate-500">
                سفارش مرتبط یافت نشد؛ کالاهای سبد خرید در زمان ارسال گزارش:
              </p>
              <ul className="divide-y divide-slate-100">
                {context?.cart?.map((item, index) => (
                  <li
                    key={`${item.name}-${index}`}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate">{item.name}</span>
                    <span className="shrink-0 text-xs text-slate-600">
                      {faNum(item.quantity)} × {faNum(item.price)} تومان
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
      <details className="group rounded-2xl border border-slate-200">
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-bold text-slate-900 [&::-webkit-details-marker]:hidden">
          جزئیات فنی
          <ChevronDown className="h-4 w-4 text-slate-500 group-open:rotate-180" />
        </summary>
        <dl className="border-t border-slate-100 px-4">
          <Row label="پنجره مرورگر" ltr>
            {context?.viewport
              ? `${context.viewport.width} × ${context.viewport.height}`
              : null}
          </Row>
          <Row label="صفحه‌نمایش" ltr>
            {context?.screen
              ? `${context.screen.width} × ${context.screen.height}`
              : null}
          </Row>
          <Row label="نسبت پیکسل" ltr>
            {context?.screen ? `${context.screen.pixelRatio}×` : null}
          </Row>
          <Row label="زبان" ltr>
            {context?.language}
          </Row>
          <Row label="منطقه زمانی" ltr>
            {context?.timeZone}
          </Row>
          <Row label="زمان دستگاه">{dateText(context?.clientTime)}</Row>
          <Row label="اتصال">
            {context?.online == null ? (
              "—"
            ) : context.online ? (
              <>
                آنلاین
                {context.connectionType && (
                  <>
                    {" "}
                    · <bdi>{context.connectionType}</bdi>
                  </>
                )}
              </>
            ) : (
              "آفلاین"
            )}
          </Row>
          <Row label="مشخصات مرورگر" ltr>
            <span className="font-mono text-xs">{report.userAgent || "—"}</span>
          </Row>
        </dl>
      </details>
    </div>
  );
}
