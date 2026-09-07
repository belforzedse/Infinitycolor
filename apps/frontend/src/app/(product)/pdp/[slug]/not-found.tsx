/**
 * PDP-scoped not-found UI.
 *
 * Kept next to the route so a missing product renders this boundary instead of
 * bubbling only to the root not-found page. The HTTP 404 status itself depends
 * on `notFound()` running before any Suspense/`loading.tsx` shell flushes — see
 * the root layout comment and
 * https://nextjs.org/docs/app/api-reference/file-conventions/loading#status-codes
 */
import Link from "next/link";

export default function ProductNotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <p className="text-sm font-medium text-infinity-primary">404</p>
      <h1 className="text-2xl font-semibold text-slate-900">
        محصول پیدا نشد (<span dir="ltr">404</span>)
      </h1>
      <p className="max-w-md text-slate-600">
        این محصول دیگر در فروشگاه موجود نیست.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/"
          className="rounded-lg bg-infinity-primary px-4 py-2 text-sm font-medium text-white"
        >
          بازگشت به فروشگاه
        </Link>
        <Link
          href="/plp"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-800"
        >
          مشاهده محصولات
        </Link>
      </div>
    </div>
  );
}
