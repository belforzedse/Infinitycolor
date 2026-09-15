"use client";

import { useEffect, useState } from "react";
import { faNum } from "@/utils/faNum";
import { priceFormatter } from "@/utils/price";
import {
  getProductBreakdown,
  type ProductBreakdown,
} from "@/services/super-admin/reports/products";
import GatewayBreakdownTable from "@/components/SuperAdmin/reports/shared/GatewayBreakdownTable";
import MetricFormula from "@/components/SuperAdmin/reports/shared/MetricFormula";
import ReportNotes from "./ReportNotes";

export default function PaymentShippingTab({ start, end }: { start: string; end: string }) {
  const [data, setData] = useState<ProductBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getProductBreakdown({ start, end })
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e?.message || "خطا در دریافت اطلاعات"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [start, end, reloadKey]);

  if (error) {
    return (
      <div className="rounded-2xl border border-red-100 bg-red-50 p-8 text-center" dir="rtl">
        <p className="mb-4 text-red-600">{error}</p>
        <button
          onClick={() => setReloadKey((k) => k + 1)}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
        >
          تلاش مجدد
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6" dir="rtl">
      {/* Sales by payment gateway */}
      <BreakdownCard
        title="دریافتی بر اساس درگاه پرداخت"
        subtitle="مبلغ دریافتی هر درگاه بر پایه تاریخ پرداخت (خالص از مرجوعی، شامل هزینه ارسال)"
        loading={loading}
        isEmpty={!loading && (data?.gateways.length ?? 0) === 0}
      >
        <GatewayBreakdownTable
          rows={data?.gateways ?? []}
          totalSales={data?.totals.gatewaySales ?? 0}
          ordersCount={data?.totals.ordersCount ?? 0}
        />
      </BreakdownCard>

      {/* Shipping revenue by shipping method */}
      <BreakdownCard
        title="درآمد ارسال بر اساس روش ارسال"
        subtitle="بر مبنای هزینه ارسال ثبت‌شده روی سفارش (نه فروش محصول)"
        loading={loading}
        isEmpty={!loading && (data?.shippingMethods.length ?? 0) === 0}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-100 text-right text-xs text-neutral-500">
              <th className="py-2 font-medium">روش ارسال</th>
              <th className="py-2 text-left font-medium">تعداد سفارش</th>
              <th className="py-2 text-left font-medium">درآمد ارسال</th>
            </tr>
          </thead>
          <tbody>
            {data?.shippingMethods.map((s) => (
              <tr key={s.method} className="border-b border-neutral-50 last:border-0">
                <td className="py-2.5 font-medium text-neutral-800">{s.method}</td>
                <td className="py-2.5 text-left text-neutral-600">{faNum(s.ordersCount)}</td>
                <td className="py-2.5 text-left text-neutral-800">
                  {priceFormatter(s.total, " تومان")}
                </td>
              </tr>
            ))}
          </tbody>
          {!loading && (data?.shippingMethods.length ?? 0) > 0 && (
            <tfoot>
              <tr className="border-t border-neutral-200 text-xs font-semibold text-neutral-700">
                <td className="py-2.5">مجموع</td>
                <td className="py-2.5 text-left" />
                <td className="py-2.5 text-left">
                  {priceFormatter(data?.totals.shippingRevenue ?? 0, " تومان")}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </BreakdownCard>

      {/*
        Same gate as the finance page's copy of this identity: a window with no
        settled cash (the "completed" fallback) has `gatewaySales` at 0 while
        shipping can be non-zero, and subtracting would show negative goods sold.
      */}
      {!loading &&
        data &&
        data.totals.gatewaySales > 0 &&
        data.totals.shippingRevenue <= data.totals.gatewaySales && (
          <MetricFormula
            terms={[
              { label: "دریافتی درگاه‌ها", value: data.totals.gatewaySales },
              { label: "درآمد ارسال", value: data.totals.shippingRevenue, op: "−" },
            ]}
            result={{
              label: "فروش کالا (بدون ارسال)",
              value: data.totals.gatewaySales - data.totals.shippingRevenue,
            }}
            note="جدول بالا پول واقعی دریافتی است و هزینه ارسال را هم در بر می‌گیرد؛ «فروش ناخالص» در نمای کلی فروش هم هزینه ارسال را دارد، اما پیش از کسر تخفیف و بر پایه تاریخ ثبت سفارش نه تاریخ پرداخت. «فروش ناخالص» همین گزارش محصولات فقط اقلام است."
          />
        )}

      {!loading && data && (
        <ReportNotes
          warnings={data.dataQualityWarnings}
          note={`${data.notes?.gatewaySales ?? ""} ${data.notes?.shippingRevenue ?? ""} ارقام به تومان و بر مبنای «سفارش‌های پرداخت‌شده» محاسبه شده‌اند.`}
        />
      )}
    </div>
  );
}

function BreakdownCard({
  title,
  subtitle,
  loading,
  isEmpty,
  children,
}: {
  title: string;
  subtitle?: string;
  loading?: boolean;
  isEmpty?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-neutral-100 bg-white p-5">
      <h3 className="text-base font-medium text-neutral-800">{title}</h3>
      {subtitle && <p className="mb-3 mt-1 text-xs text-neutral-500">{subtitle}</p>}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-neutral-100" />
          ))}
        </div>
      ) : isEmpty ? (
        <p className="py-6 text-center text-sm text-neutral-400">داده‌ای برای این بازه یافت نشد</p>
      ) : (
        children
      )}
    </div>
  );
}
