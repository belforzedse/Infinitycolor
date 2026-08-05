"use client";

import { useEffect, useState } from "react";

export default function AdminServiceWorker() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    let active = true;
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker
      .register(`/sw.js?release=${encodeURIComponent(process.env.NEXT_PUBLIC_RELEASE_SHA || "unknown")}`, {
        scope: "/",
        updateViaCache: "none",
      })
      .then((registration) => {
        if (!active) return;
        if (registration.waiting) setWaiting(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          installing?.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              setWaiting(installing);
            }
          });
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (!waiting) return null;
  return (
    <div
      className="fixed bottom-4 left-4 right-4 z-[2147483646] mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-4 shadow-xl"
      role="status"
      dir="rtl"
    >
      <p className="text-sm font-medium text-slate-800">نسخه جدید پنل مدیریت آماده است.</p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="rounded-lg bg-infinity-primary px-4 py-2 text-sm text-white"
          onClick={() => waiting.postMessage({ type: "SKIP_WAITING" })}
        >
          بروزرسانی اکنون
        </button>
        <button
          type="button"
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-700"
          onClick={() => setWaiting(null)}
        >
          بعداً
        </button>
      </div>
    </div>
  );
}
