"use client";

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { canonicalIranPhone } from "@repo/auth-core/iran-phone";
import { useAtomValue } from "jotai";
import { CheckCircle2, LoaderCircle, Send, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";

import { collectAndroidHints } from "./deviceHints";
import styles from "./IssueReportWidget.module.css";

import { currentUserAtom } from "@/lib/atoms/auth";
import { currentOrderContextAtom } from "@/atoms/issueReportContext";
import { useCart } from "@/contexts/CartContext";
import { submitIssueReport, type IssueReportClientContext } from "@/services/issue-reports";
import { generateUuidV4 } from "@/utils/uuid";

const MAX_CART_ITEMS = 20;

/** `currentOrderContextAtom` is unset before the page that owns it mounts
 * (or after a hard reload lands directly in the dialog). `pendingOrderId`
 * survives a gateway redirect specifically so the payment-result page can
 * recover from it too, so it's a reasonable last-resort order pointer here. */
function pendingOrderIdFallback(): number | null {
  try {
    const raw = window.localStorage.getItem("pendingOrderId");
    const parsed = raw ? Number(raw) : NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

type Fields = {
  number: string;
  issueName: string;
  description: string;
};

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
  return "\u0627\u0631\u0633\u0627\u0644 \u06af\u0632\u0627\u0631\u0634 \u0627\u0646\u062c\u0627\u0645 \u0646\u0634\u062f. \u062f\u0648\u0628\u0627\u0631\u0647 \u062a\u0644\u0627\u0634 \u06a9\u0646\u06cc\u062f.";
}

/**
 * The report form itself: Headless UI dialog, react-hook-form, the phone
 * validator and the submit service. `IssueReportWidget` loads this module only
 * after the trigger is pressed for the first time, so none of it sits in the
 * client bundle that every storefront route parses before hydration.
 *
 * Once mounted it stays mounted, which is what preserves the idempotency key
 * and any typed-but-unsent input across close/reopen.
 */
export default function IssueReportDialog({
  open,
  onClose,
  sent,
  onSent: setSent,
  submissionId,
  onSubmissionId: setSubmissionId,
}: {
  open: boolean;
  onClose: (value: boolean) => void;
  sent: boolean;
  onSent: (value: boolean) => void;
  submissionId: string | null;
  onSubmissionId: (update: (current: string | null) => string | null) => void;
}) {
  const pathname = usePathname();
  const user = useAtomValue(currentUserAtom);
  const orderContext = useAtomValue(currentOrderContextAtom);
  const { cartItems } = useCart();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
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

  const markEdited = () => {
    if (failed) {
      setSubmissionId(() => generateUuidV4());
      setPendingContext(null);
      setFailed(false);
    }
    setSubmitError(null);
  };

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    const orderId = orderContext?.orderId ?? pendingOrderIdFallback();
    const cart = cartItems.slice(0, MAX_CART_ITEMS).map((item) => ({
      name: item.name,
      sku: item.sku ?? null,
      quantity: item.quantity,
      price: item.price,
    }));
    const context = pendingContext || {
      ...collectContext(),
      ...(await collectAndroidHints()),
      ...(orderId ? { order: { orderId } } : {}),
      ...(cart.length > 0 ? { cart } : {}),
    };
    const activeSubmissionId = submissionId || generateUuidV4();
    if (!pendingContext) setPendingContext(context);
    if (!submissionId) setSubmissionId(() => activeSubmissionId);
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
      setSubmissionId(() => null);
      setPendingContext(null);
    } catch (error) {
      setFailed(true);
      setSubmitError(errorText(error));
    }
  });

  return (
    <Dialog open={open} onClose={onClose} className="relative z-[10000]" dir="rtl">
      <DialogBackdrop
        transition
        className={`${styles.backdrop} fixed inset-0 bg-slate-950/45 backdrop-blur-[2px]`}
      />
      <div className="fixed inset-0 flex items-end justify-center overflow-y-auto p-0 sm:items-center sm:p-4">
        <DialogPanel
          transition
          className={`${styles.panel} w-full max-w-lg rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl sm:p-6`}
        >
          <div className="mb-5 flex items-center justify-between gap-4">
            <DialogTitle className="text-lg font-bold text-slate-900">گزارش مشکل</DialogTitle>
            <button
              type="button"
              onClick={() => onClose(false)}
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
                onClick={() => onClose(false)}
                className="mt-6 min-h-11 w-full rounded-xl bg-slate-900 px-4 py-2.5 font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2"
              >
                بستن
              </button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-slate-700">شماره تماس</span>
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
                    maxLength: { value: 500, message: "عنوان باید کوتاه‌تر باشد." },
                    onChange: markEdited,
                  })}
                  maxLength={500}
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
                    maxLength: { value: 8000, message: "توضیحات باید کوتاه‌تر باشد." },
                    onChange: markEdited,
                  })}
                  rows={5}
                  maxLength={8000}
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
                {isSubmitting ? (
                  <LoaderCircle className={`${styles.busy} h-4 w-4`} aria-hidden="true" />
                ) : (
                  <Send className="h-4 w-4" aria-hidden="true" />
                )}
                {isSubmitting ? "در حال ارسال..." : "ارسال گزارش"}
              </button>
            </form>
          )}
        </DialogPanel>
      </div>
    </Dialog>
  );
}
