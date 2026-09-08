"use client";

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { canonicalIranPhone } from "@repo/auth-core";
import { useAtomValue } from "jotai";
import { CheckCircle2, LoaderCircle, MessageSquareWarning, Send, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";

import { collectAndroidHints } from "./deviceHints";
import styles from "./IssueReportWidget.module.css";
import { categoryOverlayOpenAtom } from "@/atoms/storefrontOverlay";

import { currentUserAtom } from "@/lib/atoms/auth";
import { submitIssueReport, type IssueReportClientContext } from "@/services/issue-reports";

type Fields = {
  number: string;
  issueName: string;
  description: string;
};

const HIDDEN_PREFIXES = ["/auth", "/super-admin"];

function collectContext(): IssueReportClientContext {
  const connection = (navigator as Navigator & { connection?: { effectiveType?: string } })
    .connection;
  let timeZone: string | null = null;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    timeZone = null;
  }
  return {
    clientTime: new Date().toISOString(),
    timeZone,
    language: navigator.language || "fa-IR",
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      pixelRatio: window.devicePixelRatio || 1,
    },
    online: navigator.onLine,
    connectionType: connection?.effectiveType || null,
  };
}

function errorText(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    const message = String((error as { message?: unknown }).message || "");
    if (message) return message;
  }
  return "ارسال گزارش انجام نشد. دوباره تلاش کنید.";
}

export default function IssueReportWidget() {
  const pathname = usePathname();
  const covered = useAtomValue(categoryOverlayOpenAtom);
  const user = useAtomValue(currentUserAtom);
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [pendingContext, setPendingContext] = useState<IssueReportClientContext | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<Fields>({
    defaultValues: { number: "", issueName: "", description: "" },
  });

  useEffect(() => {
    if (user?.Phone) setValue("number", user.Phone, { shouldDirty: false });
  }, [setValue, user?.Phone]);

  if (!pathname || HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;

  const markEdited = () => {
    if (failed) {
      setSubmissionId(crypto.randomUUID());
      setPendingContext(null);
      setFailed(false);
    }
    setSubmitError(null);
  };

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    const context = pendingContext || { ...collectContext(), ...await collectAndroidHints() };
    const activeSubmissionId = submissionId || crypto.randomUUID();
    if (!pendingContext) setPendingContext(context);
    if (!submissionId) setSubmissionId(activeSubmissionId);
    try {
      await submitIssueReport({
        submissionId: activeSubmissionId,
        number: values.number,
        issueName: values.issueName,
        description: values.description,
        sourcePath: pathname,
        locale: document.documentElement.lang || navigator.language || "fa-IR",
        context,
      });
      setFailed(false);
      setSent(true);
      reset({ number: user?.Phone || "", issueName: "", description: "" });
      setSubmissionId(null);
      setPendingContext(null);
    } catch (error) {
      setFailed(true);
      setSubmitError(errorText(error));
    }
  });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setSent(false);
          setSubmissionId((current) => current || crypto.randomUUID());
          setOpen(true);
        }}
        className={`${styles.trigger} fixed bottom-[calc(env(safe-area-inset-bottom)+7.5rem)] left-3 z-[80] inline-flex min-h-11 items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-xl hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 lg:bottom-6 lg:left-6`}
        hidden={covered || open}
        aria-label="گزارش مشکل"
      >
        <MessageSquareWarning className="h-5 w-5" aria-hidden="true" />
        <span>گزارش مشکل</span>
      </button>

      <Dialog open={open} onClose={setOpen} className="relative z-[10000]" dir="rtl">
        <DialogBackdrop transition className={`${styles.backdrop} fixed inset-0 bg-slate-950/45 backdrop-blur-[2px]`} />
        <div className="fixed inset-0 flex items-end justify-center overflow-y-auto p-0 sm:items-center sm:p-4">
          <DialogPanel transition className={`${styles.panel} w-full max-w-lg rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl sm:p-6`}>
            <div className="mb-5 flex items-center justify-between gap-4">
              <DialogTitle className="text-lg font-bold text-slate-900">گزارش مشکل</DialogTitle>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="grid h-10 w-10 place-items-center rounded-full text-slate-500 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary"
                aria-label="بستن"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            {sent ? (
              <div className={`${styles.success} py-7 text-center`} role="status" aria-live="polite">
                <CheckCircle2
                  className="mx-auto mb-3 h-11 w-11 text-emerald-600"
                  aria-hidden="true"
                />
                <p className="font-semibold text-slate-900">گزارش شما ثبت شد.</p>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="mt-6 min-h-11 w-full rounded-xl bg-slate-900 px-4 py-2.5 font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2"
                >
                  بستن
                </button>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-4" noValidate>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">
                    شماره تماس
                  </span>
                  <input
                    {...register("number", {
                      required: "شماره تماس را وارد کنید.",
                      validate: (value) =>
                        Boolean(canonicalIranPhone(value)) || "شماره تماس معتبر نیست.",
                      onChange: markEdited,
                    })}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    dir="ltr"
                    maxLength={64}
                    className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-left text-slate-900 outline-none transition focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/20 motion-reduce:transition-none"
                    aria-invalid={Boolean(errors.number)}
                  />
                  {errors.number && (
                    <span className="mt-1 block text-xs text-rose-600" role="alert">
                      {errors.number.message}
                    </span>
                  )}
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">عنوان</span>
                  <input
                    {...register("issueName", {
                      required: "عنوان را وارد کنید.",
                      maxLength: { value: 120, message: "عنوان باید کوتاه‌تر باشد." },
                      onChange: markEdited,
                    })}
                    maxLength={120}
                    className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-slate-900 outline-none transition focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/20 motion-reduce:transition-none"
                    aria-invalid={Boolean(errors.issueName)}
                  />
                  {errors.issueName && (
                    <span className="mt-1 block text-xs text-rose-600" role="alert">
                      {errors.issueName.message}
                    </span>
                  )}
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">توضیحات</span>
                  <textarea
                    {...register("description", {
                      required: "توضیحات را وارد کنید.",
                      maxLength: { value: 4000, message: "توضیحات باید کوتاه‌تر باشد." },
                      onChange: markEdited,
                    })}
                    rows={5}
                    maxLength={4000}
                    className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-3 text-slate-900 outline-none transition focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/20 motion-reduce:transition-none"
                    aria-invalid={Boolean(errors.description)}
                  />
                  {errors.description && (
                    <span className="mt-1 block text-xs text-rose-600" role="alert">
                      {errors.description.message}
                    </span>
                  )}
                </label>

                {submitError && (
                  <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
                    {submitError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  aria-busy={isSubmitting}
                  aria-live="polite"
                  className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-infinity-primary px-4 py-3 font-semibold text-white transition hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
                >
                  {isSubmitting ? <LoaderCircle className={`${styles.busy} h-4 w-4`} aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
                  {isSubmitting ? "در حال ارسال..." : "ارسال گزارش"}
                </button>
              </form>
            )}
          </DialogPanel>
        </div>
      </Dialog>
    </>
  );
}
