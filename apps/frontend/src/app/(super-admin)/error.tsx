'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function SuperAdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Super-admin page error:', error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 px-4">
      <div className="max-w-md rounded-3xl bg-white p-8 shadow-xl">
        <div className="mb-6 text-center">
          <h1 className="text-4xl font-bold text-red-600">بارگذاری صفحه انجام نشد</h1>
          <p className="mt-2 text-gray-600">
            دوباره تلاش کنید؛ اگر مشکل ادامه داشت، کد پیگیری زیر را به پشتیبانی
            بدهید.
          </p>
          {error.digest ? (
            <p className="mt-3 text-xs text-gray-500">
              کد پیگیری:{" "}
              <span className="font-mono" dir="ltr">
                {error.digest}
              </span>
            </p>
          ) : null}
        </div>

        {process.env.NODE_ENV === 'development' && error.message && (
          <div className="mb-6 rounded-lg bg-red-50 p-4">
            <p className="text-sm text-red-700">
              <strong>Error details:</strong> {error.message}
            </p>
          </div>
        )}

        <div className="space-y-3">
          <button
            onClick={reset}
            className="w-full rounded-lg bg-infinity-primary px-6 py-3 font-medium text-white transition-colors hover:bg-infinity-primary-dark active:scale-95"
          >
            تلاش دوباره
          </button>

          <Link href="/super-admin" prefetch={false} className="block">
            <button className="w-full rounded-lg border border-infinity-primary-lighter/60 px-6 py-3 font-medium text-infinity-primary transition-colors hover:bg-infinity-primary-lighter/20 active:scale-95">
              بازگشت به پیشخوان
            </button>
          </Link>
        </div>

        <p className="mt-6 text-center text-xs text-gray-500">
          اگر مشکل ادامه داشت با پشتیبانی تماس بگیرید.
        </p>
      </div>
    </div>
  );
}
