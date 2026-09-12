"use client";

import { useSyncExternalStore } from "react";
import {
  ANALYTICS_CONSENT_EVENT,
  getAnalyticsConsent,
  setAnalyticsConsent,
  type AnalyticsConsent,
} from "@/lib/analytics";

/**
 * `setAnalyticsConsent` dispatches the in-page event; `storage` covers another tab
 * answering the banner while this one is open.
 */
function subscribeToConsent(onChange: () => void) {
  window.addEventListener(ANALYTICS_CONSENT_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(ANALYTICS_CONSENT_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The server cannot read `localStorage`, so it always renders the banner. */
const getServerConsent = (): AnalyticsConsent => null;

/**
 * The banner renders on the server and in the first hydration render, and the
 * pre-paint script in `lib/analytics/consent-bootstrap` hides it via
 * `html[data-analytics-consent]` for a visitor who already chose.
 *
 * It used to start at `null` and only appear after an effect read `localStorage`,
 * which meant that on a first visit it painted after hydration — at ~5.0s on a
 * throttled mobile PDP, late enough to take LCP from the product hero (done at
 * ~1.6s). Rendering it up front costs nothing for returning visitors (CSS hides
 * it before paint and the store read below unmounts it) and moves a first
 * visitor's banner paint next to FCP.
 */
export function ConsentManager() {
  // `getServerConsent` is what hydration renders, so SSR and the first client
  // render agree; React then re-renders with the stored choice. Storage being
  // unavailable reads as "no decision" and keeps asking, exactly as before —
  // `getAnalyticsConsent` swallows the throw and `setAnalyticsConsent` tolerates
  // a failing write.
  const consent = useSyncExternalStore(subscribeToConsent, getAnalyticsConsent, getServerConsent);

  const grantConsent = () => setAnalyticsConsent("granted");
  const denyConsent = () => setAnalyticsConsent("denied");

  if (consent !== null) {
    return null;
  }

  return (
    <div
      data-consent-banner
      className="fixed inset-x-0 bottom-0 z-[9999] border-t border-slate-200 bg-white shadow-lg"
      dir="rtl"
      role="dialog"
      aria-label="تنظیمات تحلیل تجربه کاربری"
      aria-modal="true"
    >
      <div className="container mx-auto px-4 py-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1">
            <h3 className="mb-2 text-sm font-semibold text-slate-900">تحلیل تجربه خرید</h3>
            <p className="text-sm leading-relaxed text-slate-600">
              تحلیل پایه بدون کوکی انجام می‌شود. رد کردن، فقط جزئیات تکمیلی و سنجش عملکرد را غیرفعال
              می‌کند؛ بازدیدها، رویدادهای اصلی و شناسه داخلی حساب واردشده همچنان برای بهبود فروشگاه
              ثبت می‌شوند.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-shrink-0 sm:flex-row">
            <button
              onClick={denyConsent}
              className="rounded-lg border border-slate-300 bg-white px-6 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
              aria-label="رد تحلیل تکمیلی"
            >
              رد
            </button>
            <button
              onClick={grantConsent}
              className="rounded-lg bg-infinity-primary px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-infinity-primary-dark focus:outline-none focus:ring-2 focus:ring-infinity-primary focus:ring-offset-2"
              aria-label="پذیرش تحلیل تکمیلی"
            >
              پذیرش
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
