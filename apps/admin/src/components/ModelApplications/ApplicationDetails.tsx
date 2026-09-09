"use client";

import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
} from "@headlessui/react";
import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  getModelApplication,
  setModelApplicationStatus,
  type ModelApplicationDetail,
  type ModelApplicationStatus,
} from "@/services/model-applications";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import { STATUS } from "./shared";

type Props = {
  applicationId: string | null;
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

export default function ApplicationDetails(props: Props) {
  return (
    <Dialog
      open={Boolean(props.applicationId)}
      onClose={props.onClose}
      className="relative z-[100]"
      dir="rtl"
    >
      <DialogBackdrop className="fixed inset-0 bg-slate-950/35" />
      <div className="pointer-events-none fixed inset-y-0 left-0 flex max-w-full sm:pl-6">
        <DialogPanel className="pointer-events-auto h-full w-screen max-w-2xl overflow-y-auto bg-white shadow-2xl">
          <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur sm:px-7">
            <DialogTitle className="text-lg font-bold text-slate-900">
              جزئیات درخواست مدل
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
          {props.applicationId && (
            <ApplicationContent
              key={props.applicationId}
              applicationId={props.applicationId}
              onChanged={props.onChanged}
            />
          )}
        </DialogPanel>
      </div>
    </Dialog>
  );
}

function ApplicationContent({
  applicationId,
  onChanged,
}: {
  applicationId: string;
  onChanged: () => void;
}) {
  const [application, setApplication] = useState<ModelApplicationDetail | null>(
    null,
  );
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
    getModelApplication(applicationId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setApplication(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("دریافت درخواست انجام نشد. دوباره تلاش کنید.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [applicationId, revision]);

  async function changeStatus(status: ModelApplicationStatus) {
    if (!application || saving || status === application.status) return;
    setSaving(true);
    setError("");
    try {
      const updated = await setModelApplicationStatus(
        applicationId,
        status,
        application.version,
      );
      if (!alive.current) return;
      setApplication(updated);
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
          const updated = await getModelApplication(applicationId);
          if (!alive.current) return;
          setApplication(updated);
          onChanged();
          setError(
            "وضعیت درخواست تغییر کرده بود. اطلاعات به‌روز شد؛ دوباره انتخاب کنید.",
          );
        } catch {
          if (alive.current) {
            setApplication(null);
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
        در حال دریافت درخواست…
      </div>
    );
  if (!application)
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

  const photos = [
    { label: "عکس اول", photo: application.photoOne },
    { label: "عکس دوم", photo: application.photoTwo },
  ];

  return (
    <div className="space-y-6 p-5 sm:p-7">
      <section className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-xl font-bold leading-8 text-slate-900">
              {application.fullName}
            </h2>
            <p className="mt-1 text-xs leading-6 text-slate-500">
              {dateText(application.submittedAt)}
            </p>
          </div>
          <label className="shrink-0">
            <span className="sr-only">وضعیت</span>
            <select
              aria-label="وضعیت"
              value={application.status}
              disabled={saving}
              onChange={(event) =>
                void changeStatus(event.target.value as ModelApplicationStatus)
              }
              className={`min-h-11 rounded-xl border-0 px-3 text-sm font-semibold ring-1 ring-inset disabled:opacity-60 ${STATUS[application.status].className}`}
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
      </section>
      <section>
        <h3 className="mb-2 font-bold text-slate-900">اطلاعات متقاضی</h3>
        <dl className="rounded-2xl border border-slate-200 px-4">
          <Row label="شماره تماس" ltr>
            <a
              href={`tel:${application.phone}`}
              className="text-blue-700 hover:underline"
            >
              {application.phone}
            </a>
          </Row>
          <Row label="ایمیل" ltr>
            {application.email ? (
              <a
                href={`mailto:${application.email}`}
                className="text-blue-700 hover:underline"
              >
                {application.email}
              </a>
            ) : null}
          </Row>
          <Row label="سن">{application.age}</Row>
          <Row label="قد">
            {application.heightCm ? `${application.heightCm} سانتی‌متر` : null}
          </Row>
          <Row label="شهر">{application.city}</Row>
          <Row label="حساب کاربری">
            {application.reporterUserId ? (
              <bdi>#{application.reporterUserId}</bdi>
            ) : (
              "مهمان"
            )}
          </Row>
        </dl>
      </section>
      {application.experience && (
        <section>
          <h3 className="mb-2 font-bold text-slate-900">سابقه کاری</h3>
          <p className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm leading-8 text-slate-700 [overflow-wrap:anywhere]">
            {application.experience}
          </p>
        </section>
      )}
      <section>
        <h3 className="mb-3 font-bold text-slate-900">تصاویر</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {photos.map(({ label, photo }) => (
            <figure
              key={label}
              className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50"
            >
              {photo ? (
                <img
                  src={resolveAssetUrl(photo.url)}
                  alt={photo.name || label}
                  className="h-64 w-full object-cover"
                />
              ) : (
                <div className="grid h-40 place-items-center text-sm text-slate-400">
                  تصویری ارسال نشده
                </div>
              )}
              <figcaption className="px-3 py-2 text-xs text-slate-500">
                {label}
              </figcaption>
            </figure>
          ))}
        </div>
      </section>
    </div>
  );
}
