"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

type StorefrontRecoveryStateProps = {
  title: string;
  message: string;
  error?: Error & { digest?: string };
  surface: "root" | "product" | "catalog" | "account";
  onRetry?: () => void;
  retryLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
};

export default function StorefrontRecoveryState({
  title,
  message,
  error,
  surface,
  onRetry,
  retryLabel = "تلاش دوباره",
  secondaryHref = "/",
  secondaryLabel = "بازگشت به فروشگاه",
}: StorefrontRecoveryStateProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!error || !process.env.NEXT_PUBLIC_SENTRY_DSN) return;
    Sentry.withScope((scope) => {
      scope.setTag("recovery_surface", surface);
      if (error.digest) scope.setTag("next_error_digest", error.digest);
      Sentry.captureException(error);
    });
  }, [error, surface]);

  return (
    <main
      className="mx-auto flex min-h-[55vh] w-full max-w-2xl items-center justify-center px-4 py-12"
      dir="rtl"
      role="alert"
    >
      <section className="w-full rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm sm:p-9">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-700">
          <AlertTriangle className="h-7 w-7" aria-hidden="true" />
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mt-5 text-xl font-bold text-slate-900 outline-none sm:text-2xl"
        >
          {title}
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-7 text-slate-600 sm:text-base">
          {message}
        </p>

        <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-infinity-primary px-5 py-2.5 font-medium text-white transition hover:bg-infinity-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {retryLabel}
            </button>
          )}
          <Link
            href={secondaryHref}
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 px-5 py-2.5 font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2"
          >
            {secondaryLabel}
          </Link>
        </div>
      </section>
    </main>
  );
}
