import Link from "next/link";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default function ReportsIndexPage() {
  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-bold">گزارش‌ها</h1>
      <ul className="list-disc space-y-2 pr-6">
        <li>
          <Link
            className="text-infinity-primary"
            href="/super-admin/reports/traffic"
            prefetch={false}
          >
            گزارش ترافیک و رفتار کاربران
          </Link>
        </li>
        <li>
          <Link
            className="text-infinity-primary"
            href="/super-admin/reports/liquidity"
            prefetch={false}
          >
            گزارش مجموع نقدینگی در بازه
          </Link>
        </li>
        <li>
          <Link
            className="text-infinity-primary"
            href="/super-admin/reports/product-sales"
            prefetch={false}
          >
            گزارش محصولات (نمای کلی، روند، عملکرد و موجودی)
          </Link>
        </li>
        <li>
          <Link
            className="text-infinity-primary"
            href="/super-admin/reports/gateway-liquidity"
            prefetch={false}
          >
            گزارش مجموع نقدینگی هر درگاه
          </Link>
        </li>
        <li>
          <Link
            className="text-infinity-primary"
            href="/super-admin/reports/admin-activity"
            prefetch={false}
          >
            گزارش ادمین ها
          </Link>
        </li>
      </ul>
    </div>
  );
}
