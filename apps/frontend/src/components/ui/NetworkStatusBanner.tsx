"use client";

import { useEffect, useRef, useState } from "react";
import { Wifi, WifiOff } from "lucide-react";

export default function NetworkStatusBanner() {
  const [offline, setOffline] = useState(false);
  const wasOffline = useRef(false);
  const [recovered, setRecovered] = useState(false);

  useEffect(() => {
    let recoveryTimer: number | undefined;
    const markOffline = () => {
      if (wasOffline.current) return;
      if (recoveryTimer) window.clearTimeout(recoveryTimer);
      wasOffline.current = true;
      setRecovered(false);
      setOffline(true);
    };
    const markOnline = () => {
      setOffline(false);
      if (!wasOffline.current) return;
      wasOffline.current = false;
      setRecovered(true);
      window.dispatchEvent(new Event("app:back-online"));
      if (recoveryTimer) window.clearTimeout(recoveryTimer);
      recoveryTimer = window.setTimeout(() => setRecovered(false), 3000);
    };

    if (navigator.onLine === false) markOffline();
    window.addEventListener("offline", markOffline);
    window.addEventListener("online", markOnline);
    return () => {
      window.removeEventListener("offline", markOffline);
      window.removeEventListener("online", markOnline);
      if (recoveryTimer) window.clearTimeout(recoveryTimer);
    };
  }, []);

  if (!offline && !recovered) return null;

  return (
    <div
      className={`fixed left-1/2 top-3 z-[9999] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lg ${
        offline ? "bg-slate-900 text-white" : "bg-emerald-700 text-white"
      }`}
      dir="rtl"
      role="status"
      aria-live="polite"
      data-testid="network-status"
    >
      {offline ? (
        <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
      ) : (
        <Wifi className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <span>
        {offline
          ? "اتصال اینترنت قطع است؛ تغییرات حساب تا اتصال دوباره ثبت نمی‌شوند"
          : "اتصال اینترنت برقرار شد"}
      </span>
    </div>
  );
}
