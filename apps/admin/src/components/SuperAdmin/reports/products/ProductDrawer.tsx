"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { faNum } from "@/utils/faNum";
import { priceFormatter } from "@/utils/price";
import { getProductDetail, type ProductDetail } from "@/services/super-admin/reports/products";
import TimeSeriesChart from "../shared/TimeSeriesChart";
import { tehranToday, tomanText } from "../shared/format";
import { salesSeriesRows } from "../shared/salesSeries";

const STATUS_FA: Record<string, string> = {
  in: "موجود",
  low: "کم",
  out: "ناموجود",
  unknown: "نامشخص",
};
const STATUS_TONE: Record<string, string> = {
  in: "bg-green-50 text-green-600",
  low: "bg-amber-50 text-amber-600",
  out: "bg-red-50 text-red-600",
  unknown: "bg-neutral-100 text-neutral-500",
};

export default function ProductDrawer({
  productId,
  start,
  end,
  onClose,
}: {
  productId: number;
  start: string;
  end: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getProductDetail({ productId, start, end })
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e?.message || "خطا در دریافت اطلاعات"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [productId, start, end]);

  const trendRows = useMemo(
    () =>
      data?.trend.length
        ? salesSeriesRows({
            points: data.trend,
            grouping: data.grouping,
            range: { start, end },
            today: tehranToday(),
            value: (point) => point.gross,
          })
        : null,
    [data, start, end],
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-start" dir="rtl">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div className="relative h-full w-full max-w-xl overflow-y-auto bg-neutral-50 shadow-xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-neutral-200 bg-white px-5 py-4">
          <h2 className="truncate text-lg font-bold text-neutral-800">
            {data?.product.title || "جزئیات محصول"}
          </h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
            aria-label="بستن"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 p-5">
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded-xl bg-white" />
              ))}
            </div>
          ) : error ? (
            <div className="rounded-xl bg-red-50 p-6 text-center text-red-600">{error}</div>
          ) : data ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/products/${data.product.id}`}
                  className="rounded-lg bg-infinity-primary px-4 py-2 text-sm text-white"
                >
                  ویرایش محصول
                </Link>
                <Link
                  href="/orders"
                  className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-700"
                >
                  مشاهده سفارش‌ها
                </Link>
              </div>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="فروش ناخالص" value={priceFormatter(data.totals.gross, " ت")} />
                <Stat label="خالص فروش" value={priceFormatter(data.totals.net, " ت")} />
                <Stat label="تعداد فروش" value={faNum(data.totals.units)} />
                <Stat label="موجودی کل محصول" value={faNum(data.totals.currentStock)} />
              </div>

              {trendRows ? (
                <div className="rounded-2xl border border-neutral-100 bg-white p-3">
                  <p className="mb-2 text-sm font-medium text-neutral-600">روند فروش ناخالص</p>
                  <TimeSeriesChart
                    rows={trendRows}
                    seriesLabel="فروش ناخالص"
                    valueText={tomanText}
                    heightClass="h-44"
                    yAxisWidth={64}
                    gradientId="product-drawer-trend-fill"
                  />
                </div>
              ) : null}

              <div className="rounded-2xl border border-neutral-100 bg-white p-3">
                <p className="mb-3 text-sm font-medium text-neutral-600">عملکرد تنوع‌ها</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-neutral-400">
                      <tr>
                        <th className="px-2 py-2 text-right">SKU</th>
                        <th className="px-2 py-2 text-right">رنگ / سایز</th>
                        <th className="px-2 py-2 text-right">ویژگی‌ها</th>
                        <th className="px-2 py-2 text-right">تعداد</th>
                        <th className="px-2 py-2 text-right">خالص</th>
                        <th className="px-2 py-2 text-right">موجودی متغیر</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.variations.map((v) => (
                        <tr key={v.variationId} className="border-t border-neutral-100">
                          <td className="px-2 py-2 font-mono text-xs text-neutral-700">{v.sku}</td>
                          <td className="px-2 py-2 text-neutral-700">
                            {v.variantLabel || <span className="text-neutral-300">—</span>}
                          </td>
                          <td
                            className="max-w-[160px] truncate px-2 py-2 text-xs text-neutral-500"
                            title={v.variantOther || undefined}
                          >
                            {v.variantOther || <span className="text-neutral-300">—</span>}
                          </td>
                          <td className="px-2 py-2">{faNum(v.units)}</td>
                          <td className="px-2 py-2">{priceFormatter(v.net, " ت")}</td>
                          <td className="px-2 py-2">
                            <span
                              className={`rounded-md px-2 py-0.5 text-xs ${STATUS_TONE[v.stockStatus]}`}
                            >
                              {v.currentStock === null ? "—" : faNum(v.currentStock)} ·{" "}
                              {STATUS_FA[v.stockStatus]}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-100 bg-white p-3">
      <p className="mb-1 text-xs text-neutral-400">{label}</p>
      <p className="text-sm font-bold text-neutral-800">{value}</p>
    </div>
  );
}
