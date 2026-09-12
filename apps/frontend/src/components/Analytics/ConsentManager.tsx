"use client";

import { useEffect, useState } from "react";
import { ANALYTICS_CONSENT_STORAGE_KEY, setAnalyticsConsent } from "@/lib/analytics";

/**
 * The banner renders on the server and in the first hydration render, and the
 * pre-paint script in `lib/analytics/consent-bootstrap` hides it via
 * `html[data-analytics-consent]` for a visitor who already chose.
 *
 * It used to start at `null` and only appear after an effect read `localStorage`,
 * which meant that on a first visit it painted after hydration — at ~5.0s on a
 * throttled mobile PDP, late enough to take LCP from the product hero (done at
 * ~1.6s). Rendering it up front costs nothing for returning visitors (CSS hides
 * it before paint and the effect below unmounts it) and moves a first visitor's
 * banner paint next to FCP.
 */
export function ConsentManager() {
  // Must match the server render, which cannot know the stored choice.
  const [showBanner, setShowBanner] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let storedConsent: string | null = null;
    try {
      storedConsent = localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY);
    } catch {
      // Storage unavailable: treat it as no decision and keep asking, exactly as
      // before. `setAnalyticsConsent` already tolerates a failing write.
    }
    const hasConsent = storedConsent === "granted" || storedConsent === "denied";
    if (hasConsent) setShowBanner(false);
  }, []);

  const grantConsent = () => {
    if (typeof window === "undefined") return;
    setAnalyticsConsent("granted");
    setShowBanner(false);
  };

  const denyConsent = () => {
    if (typeof window === "undefined") return;
    setAnalyticsConsent("denied");
    setShowBanner(false);
  };

  if (!showBanner) {
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
