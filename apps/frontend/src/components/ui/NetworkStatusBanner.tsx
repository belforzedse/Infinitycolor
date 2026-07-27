"use client";

import { useEffect, useState } from "react";
import { Wifi, WifiOff } from "lucide-react";

export default function NetworkStatusBanner() {
  const [status, setStatus] = useState<"online" | "offline" | null>(null);

  useEffect(() => {
    const markOffline = () => setStatus("offline");
    const markOnline = () => {
      setStatus((current) => (current === "offline" ? "online" : null));
    };

    if (!navigator.onLine) markOffline();
    window.addEventListener("offline", markOffline);
    window.addEventListener("online", markOnline);
    return () => {
      window.removeEventListener("offline", markOffline);
      window.removeEventListener("online", markOnline);
    };
  }, []);

  useEffect(() => {
    if (status !== "online") return;
    const timeoutId = window.setTimeout(() => setStatus(null), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [status]);

  if (!status) return null;

  const offline = status === "offline";
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
