"use client";

import { useEffect, useState } from "react";

interface ErrorNotificationProps {
  status: number;
  message?: string;
  onDismiss?: () => void;
}

/**
 * Friendly error notification component.
 * This is a transient notification, not a full page, so it never shows an HTTP
 * status code or raw error text - only what happened and what to do next.
 * 401 additionally offers a login link.
 */
export function ErrorNotification({ status, message, onDismiss }: ErrorNotificationProps) {
  const [isVisible, setIsVisible] = useState(true);

  const getErrorInfo = (code: number) => {
    switch (code) {
      case 401:
        return {
          title: "برای ادامه وارد شوید",
          message: message || "برای دیدن این بخش باید وارد حساب خود شوید.",
          icon: "🔐",
          action: { label: "ورود", href: "/auth" },
        };
      case 403:
        return {
          title: "دسترسی ندارید",
          message: message || "این بخش برای حساب شما در دسترس نیست.",
          icon: "⛔",
          action: null,
        };
      case 404:
        return {
          title: "پیدا نشد",
          message: message || "چیزی که دنبالش بودید دیگر در دسترس نیست.",
          icon: "🔍",
          action: null,
        };
      default:
        return {
          title: "انجام نشد",
          message: message || "درخواست شما انجام نشد. دوباره تلاش کنید.",
          icon: "⚠️",
          action: null,
        };
    }
  };

  const { title, message: errorMessage, icon, action } = getErrorInfo(status);

  if (!isVisible) return null;

  const handleDismiss = () => {
    setIsVisible(false);
    onDismiss?.();
  };

  const handleAction = () => {
    if (action?.href) {
      window.location.href = action.href;
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-[1000] max-w-sm">
      <div className="bg-white rounded-lg shadow-lg border-r-4 border-red-500 p-4">
        <div className="flex gap-3">
          <div className="text-2xl flex-shrink-0">{icon}</div>
          <div className="flex-1">
            <h3 className="font-semibold text-foreground-primary">{title}</h3>
            <p className="text-sm text-foreground-secondary mt-1">{errorMessage}</p>
            {action && (
              <button
                onClick={handleAction}
                className="mt-3 text-sm text-blue-600 hover:text-blue-700 font-medium"
              >
                {action.label} →
              </button>
            )}
          </div>
          <button
            onClick={handleDismiss}
            className="flex-shrink-0 text-foreground-tertiary hover:text-foreground-primary"
            aria-label="بستن"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
