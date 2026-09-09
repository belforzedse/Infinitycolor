"use client";

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type NavigatorLegacy = Navigator & {
  vendor?: string;
  opera?: string;
};

function readUserAgent(): string {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as NavigatorLegacy;
  return `${nav.userAgent} ${nav.vendor ?? ""} ${nav.opera ?? ""}`.toLowerCase();
}

function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;
  if (window.innerWidth >= 768) return false;

  const userAgent = readUserAgent();
  const mobileRegex = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i;
  const isIPadOS = navigator.maxTouchPoints > 1 && /MacIntel/.test(navigator.platform);

  return mobileRegex.test(userAgent) || isIPadOS;
}

function isIOSDevice(): boolean {
  if (typeof window === "undefined") return false;
  return /iphone|ipad|ipod/i.test(readUserAgent());
}

function isSafariIOS(): boolean {
  if (typeof window === "undefined") return false;
  const userAgent = readUserAgent();
  const isIOS = /iphone|ipad|ipod/i.test(userAgent);
  const isSafari = /safari/i.test(userAgent) && !/chrome|crios|fxios/i.test(userAgent);
  return isIOS && isSafari;
}

export type PWAInstallPromptCardProps = {
  isIOS: boolean;
  onInstall: () => void;
  onDismiss: () => void;
};

/**
 * Compact install card. Keep this small enough that action buttons stay on-screen
 * on short phones; a full-screen sheet previously overflowed and trapped taps.
 */
export function PWAInstallPromptCard({ isIOS, onInstall, onDismiss }: PWAInstallPromptCardProps) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[1300] flex items-end justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:inset-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pwa-install-title"
      data-testid="pwa-install-prompt"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        onClick={onDismiss}
        aria-label="بستن"
      />

      <div className="relative w-full max-w-[17.5rem] overflow-hidden rounded-2xl bg-white p-3 shadow-xl rtl:text-right">
        <button
          type="button"
          onClick={onDismiss}
          className="absolute end-1.5 top-1.5 flex size-8 touch-manipulation items-center justify-center rounded-full text-gray-500"
          aria-label="بستن"
        >
          <span aria-hidden="true" className="text-lg leading-none">
            ×
          </span>
        </button>

        <div className="flex items-start gap-2.5 pe-6">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-infinity-primary text-white">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="size-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
              />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="pwa-install-title" className="text-sm font-semibold text-gray-900">
              نصب اپلیکیشن
            </h2>
            <p className="mt-0.5 text-xs leading-5 text-gray-600">
              {isIOS
                ? "از Share گزینه Add to Home Screen را بزنید."
                : "برای دسترسی سریع‌تر به صفحه اصلی اضافه کنید."}
            </p>
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          {isIOS ? (
            <button
              type="button"
              onClick={onDismiss}
              className="min-h-10 flex-1 touch-manipulation rounded-xl bg-infinity-primary px-3 text-sm font-semibold text-white"
            >
              متوجه شدم
            </button>
          ) : (
            <button
              type="button"
              onClick={onInstall}
              className="min-h-10 flex-1 touch-manipulation rounded-xl bg-infinity-primary px-3 text-sm font-semibold text-white"
            >
              نصب
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="min-h-10 flex-1 touch-manipulation rounded-xl bg-gray-100 px-3 text-sm font-semibold text-gray-700"
          >
            بعداً
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * PWA Install Prompt Component
 * Compact mobile card, shown at most once per user.
 */
export default function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const mobile = isMobileDevice();
    const ios = isIOSDevice();
    setIsMobile(mobile);
    setIsIOS(ios);

    if (!mobile) {
      return;
    }

    if (window.matchMedia("(display-mode: standalone)").matches) {
      setIsInstalled(true);
      return;
    }

    const wasInstalled = localStorage.getItem("pwa-installed");
    if (wasInstalled === "true") {
      setIsInstalled(true);
      return;
    }

    const wasDismissed = localStorage.getItem("pwa-prompt-dismissed-permanently");
    if (wasDismissed === "true") {
      return;
    }

    const isSecure =
      window.location.protocol === "https:" ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    if (!isSecure) {
      return;
    }

    if (ios && isSafariIOS()) {
      const timer = setTimeout(() => {
        setShowPrompt(true);
      }, 2000);
      return () => clearTimeout(timer);
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowPrompt(true);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setShowPrompt(false);
      localStorage.setItem("pwa-installed", "true");
    };

    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) {
      localStorage.setItem("pwa-prompt-dismissed-permanently", "true");
      setShowPrompt(false);
      return;
    }

    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;

      if (outcome === "accepted") {
        localStorage.setItem("pwa-installed", "true");
      } else {
        localStorage.setItem("pwa-prompt-dismissed-permanently", "true");
      }
    } catch {
      localStorage.setItem("pwa-prompt-dismissed-permanently", "true");
    } finally {
      setDeferredPrompt(null);
      setShowPrompt(false);
    }
  };

  const handleDismiss = () => {
    localStorage.setItem("pwa-prompt-dismissed-permanently", "true");
    setShowPrompt(false);
  };

  if (!isMobile || isInstalled || !showPrompt) {
    return null;
  }

  return (
    <PWAInstallPromptCard isIOS={isIOS} onInstall={() => void handleInstallClick()} onDismiss={handleDismiss} />
  );
}
