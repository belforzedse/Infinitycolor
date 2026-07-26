"use client";

import { useEffect } from "react";

export default function PLPError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Product list failed to load", error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[50vh] max-w-2xl flex-col items-center justify-center px-4 text-center" dir="rtl">
      <h1 className="text-xl font-semibold text-neutral-900">دریافت محصولات انجام نشد</h1>
      <p className="mt-3 text-sm leading-7 text-neutral-600">
        این وضعیت به معنی خالی بودن فروشگاه نیست. اتصال با سرویس محصولات برقرار نشد؛ لطفاً دوباره تلاش کنید.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-5 rounded-xl bg-infinity-primary px-5 py-2.5 text-sm font-medium text-white"
      >
        تلاش دوباره
      </button>
    </main>
  );
}
