"use client";

import { useEffect, useMemo, useState } from "react";
import { faNum } from "@/utils/faNum";
import { priceFormatter } from "@/utils/price";
import { cn } from "@/utils/tailwind";
import { CARD, ErrorState, SkeletonBlock } from "@/components/admin";
import { ShareCell } from "@/components/SuperAdmin/reports/shared/AnalyticsTable";
import { ShareSummary, ShareTip } from "@/components/SuperAdmin/reports/shared/ShareBar";
import { buildShares, shareOf } from "@/components/SuperAdmin/reports/shared/shares";
import { numberText, ratioText, tomanText } from "@/components/SuperAdmin/reports/shared/format";
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

  const methods = useMemo(() => data?.shippingMethods ?? [], [data]);
  const shippingShares = useMemo(
    () =>
      buildShares(
        methods.map((method) => ({
          key: method.method,
          label: method.method,
          value: method.total,
          unknown: method.method === "نامشخص",
        })),
      ),
    [methods],
  );
  const shippingTotal = data?.totals.shippingRevenue ?? 0;

  if (error) {
    return <ErrorState description={error} onRetry={() => setReloadKey((k) => k + 1)} />;
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
          paymentMix={data?.paymentMix}
        />
      </BreakdownCard>

      {/* Shipping revenue by shipping method */}
      <BreakdownCard
        title="درآمد ارسال بر اساس روش ارسال"
        subtitle="بر مبنای هزینه ارسال ثبت‌شده روی سفارش (نه فروش محصول)"
        loading={loading}
        isEmpty={!loading && (data?.shippingMethods.length ?? 0) === 0}
      >
        {shippingShares ? (
          <ShareSummary
            className="mb-4"
            segments={shippingShares.segments}
            label="سهم روش‌های ارسال از درآمد ارسال"
            describe={(segment) => `${segment.label}: ${ratioText(segment.share)}، ${tomanText(segment.value)}`}
            tipContent={(segment) => {
              const method = methods.find((entry) => entry.method === segment.key);
              return (
                <ShareTip
                  segment={segment}
                  valueText={tomanText(segment.value)}
                  extra={method ? <p className="text-slate-600">{numberText(method.ordersCount)} سفارش</p> : null}
                />
              );
            }}
            note={
              shippingShares.excluded
                ? `${numberText(shippingShares.excluded)} روش بدون درآمد ارسال (مثلاً ارسال رایگان) در سهم‌ها نیامده است.`
                : null
            }
          />
        ) : null}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-100 text-right text-xs text-neutral-500">
              <th scope="col" className="py-2 font-medium">روش ارسال</th>
              <th scope="col" className="py-2 text-left font-medium">تعداد سفارش</th>
              <th scope="col" className="py-2 text-left font-medium">درآمد ارسال</th>
            </tr>
          </thead>
          <tbody>
            {methods.map((s) => (
              <tr key={s.method} className="border-b border-neutral-50 last:border-0">
                <td className="py-2.5 font-medium text-neutral-800">{s.method}</td>
                <td className="py-2.5 text-left tabular-nums text-neutral-600">{faNum(s.ordersCount)}</td>
                <td className="py-2.5 text-left tabular-nums text-neutral-800">
                  <ShareCell share={shareOf(s.total, shippingTotal)}>{priceFormatter(s.total, " تومان")}</ShareCell>
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
    <div className={cn(CARD, "p-4 md:p-5")}>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {subtitle && <p className="mb-4 mt-1 text-xs text-slate-600">{subtitle}</p>}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-9" />
          ))}
        </div>
      ) : isEmpty ? (
        <p className="rounded-control border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-500">
          داده‌ای برای این بازه یافت نشد
        </p>
      ) : (
        children
      )}
    </div>
  );
}
