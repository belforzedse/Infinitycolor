import Link from "next/link";
export default function ReportsIndexPage() {
  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-bold">گزارش‌ها</h1>
      <ul className="list-disc space-y-2 pr-6">
        <li>
          <Link className="text-infinity-primary" href="/reports/traffic">
            گزارش ترافیک و رفتار کاربران
          </Link>
        </li>
        <li>
          <Link className="text-infinity-primary" href="/reports/liquidity">
            گزارش مجموع نقدینگی در بازه
          </Link>
        </li>
        <li>
          <Link className="text-infinity-primary" href="/reports/product-sales">
            گزارش محصولات (نمای کلی، روند، عملکرد و موجودی)
          </Link>
        </li>
        <li>
          <Link className="text-infinity-primary" href="/reports/gateway-liquidity">
            گزارش مجموع نقدینگی هر درگاه
          </Link>
        </li>
        <li>
          <Link className="text-infinity-primary" href="/reports/admin-activity">
            گزارش ادمین ها
          </Link>
        </li>
      </ul>
    </div>
  );
}
