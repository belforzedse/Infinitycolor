"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { TRANSIENT_NETWORK_MESSAGES } from "@/lib/storefront-sentry-tags";

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

// Mobile Safari drops the in-flight RSC stream when a tab is backgrounded or
// a navigation is interrupted mid-fetch; React's Flight client surfaces the
// half-read payload as "Connection closed." Safari fetch failures use the
// exact TypeError message "Load failed"; Chromium uses "Failed to fetch" or
// "network error". Those are network blips, not app errors, so one silent
// re-fetch happens before the recovery UI is shown. They are never sent to
// Sentry from this boundary — even after the retry window — because they are
// not defects. The global handler may still see them; beforeSend tags those
// as transport_cut=rsc (Next 16.3.2; cacheComponents notFound Flight holes
// were addressed upstream in #92231/#94037 — residual events are usually
// tab/proxy cuts, not a version gap we bump for in this pass).
// Blocks a tight fail-loop (retry -> same stream cut -> retry -> ...) without
// permanently spending the one auto-retry for the rest of a long-lived SPA
// session, where Safari can background/cut the connection again minutes later.
const TRANSIENT_RETRY_WINDOW_MS = 30_000;

// Module-scoped so the window holds across the fresh component instance each
// error-boundary retry mounts; it naturally expires on its own.
let lastTransientAutoRetryAt = 0;

function isTransientNetworkError(error?: Error): boolean {
  if (!error) return false;
  if (error.name === "AbortError" || error.name === "NetworkError") return true;
  return Boolean(error.message && TRANSIENT_NETWORK_MESSAGES.has(error.message));
}

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
  const [autoRetrying] = useState(
    () =>
      Boolean(onRetry) &&
      isTransientNetworkError(error) &&
      Date.now() - lastTransientAutoRetryAt > TRANSIENT_RETRY_WINDOW_MS,
  );

  useEffect(() => {
    if (!autoRetrying) headingRef.current?.focus();
  }, [autoRetrying]);

  useEffect(() => {
    if (!autoRetrying) return;
    lastTransientAutoRetryAt = Date.now();
    onRetry?.();
  }, [autoRetrying, onRetry]);

  useEffect(() => {
    if (autoRetrying) return;
    if (!error || !process.env.NEXT_PUBLIC_SENTRY_DSN) return;
    // Known transport cuts are recovered in-UI. Reporting them as errors after
    // the one silent retry filled Sentry with Connection closed / network error
    // groups that are not application defects.
    if (isTransientNetworkError(error)) return;
    Sentry.withScope((scope) => {
      scope.setTag("recovery_surface", surface);
      if (error.digest) scope.setTag("next_error_digest", error.digest);
      Sentry.captureException(error);
    });
  }, [autoRetrying, error, surface]);

  if (autoRetrying) {
    return null;
  }

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
        {error?.digest ? (
          <p className="mt-3 text-xs text-slate-500">
            کد پیگیری:{" "}
            <span className="font-mono" dir="ltr">
              {error.digest}
            </span>
          </p>
        ) : null}

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
