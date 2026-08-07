"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SalesPage from "./_components/SalesPage";
import KpiCard from "@/components/SuperAdmin/reports/products/KpiCard";
import ReportDateRangeField from "@/components/SuperAdmin/reports/shared/ReportDateRangeField";
import { useReportQueryState } from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import { toDateOnly, parseDateOnly } from "@/components/SuperAdmin/reports/shared/reportDates";
import { getOverview, type OverviewResponse } from "@/services/super-admin/reports/overview";
import { faNum } from "@/utils/faNum";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";

type ReconciliationStatus = NonNullable<OverviewResponse["reconciliation"]>["status"];

const RECONCILIATION_LABELS: Record<ReconciliationStatus, { label: string; className: string }> = {
  matched: { label: "منطبق", className: "bg-green-50 text-green-700" },
  diverged: { label: "واگرا", className: "bg-amber-50 text-amber-700" },
  matomo_unavailable: { label: "ماتومو در دسترس نیست", className: "bg-neutral-100 text-neutral-500" },
};

export default function OverviewReportPage() {
  const { start, end, setRange } = useReportQueryState<never>({ tab: false });
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getOverview({ start, end })
      .then((res) => {
        if (active) setData(res);
      })
      .catch((err) => {
        if (active) setError(getUserFacingErrorMessage(err, "خطا در بارگذاری نمای کلی"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [start, end]);

  const reconciliation = data?.reconciliation;
  const reconciliationInfo = reconciliation ? RECONCILIATION_LABELS[reconciliation.status] : null;

  return (
    <SalesPage title="نمای کلی فروش">
      <div className="space-y-6" dir="rtl">
        {error && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {loading && (
          <div>
            <h3 className="mb-3 text-lg font-medium text-neutral-700">فروش</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <KpiCard title="فروش ناخالص" format="toman" loading />
              <KpiCard title="فروش خالص" format="toman" loading />
              <KpiCard title="سفارش‌ها" format="count" loading />
              <KpiCard title="تعداد فروش" format="count" loading />
              <KpiCard title="تخفیف‌ها" format="toman" loading />
              <KpiCard title="مرجوعی‌ها" format="toman" loading />
            </div>
          </div>
        )}

        {!loading && data && (
          <>
            <div>
              <h3 className="mb-3 text-lg font-medium text-neutral-700">فروش</h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <KpiCard title="فروش ناخالص" delta={data.sales.gross} format="toman" />
                <KpiCard title="فروش خالص" delta={data.sales.net} format="toman" />
                <KpiCard title="سفارش‌ها" delta={data.sales.orders} format="count" />
                <KpiCard title="تعداد فروش" delta={data.sales.units} format="count" />
                <KpiCard title="تخفیف‌ها" delta={data.sales.discounts} format="toman" />
                <KpiCard title="مرجوعی‌ها" delta={data.sales.refunds} format="toman" />
              </div>
              <Link
                href="/sales/breakdown"
                className="mt-3 inline-block text-xs text-infinity-primary hover:underline"
              >
                مشاهده تفکیک فروش بر اساس وضعیت، دسته‌بندی، مشتری، کوپن و استان ←
              </Link>
            </div>

            <div>
              <h3 className="mb-3 text-lg font-medium text-neutral-700">ترافیک</h3>
              {data.traffic === null ? (
                <div className="rounded-2xl border border-neutral-100 bg-white p-5 text-sm text-neutral-500">
                  ماتومو پیکربندی نشده یا در دسترس نیست — داده ترافیک موجود نیست.
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <KpiCard title="بازدیدها" delta={data.traffic.visits} format="count" />
                  <KpiCard title="بازدیدکنندگان یکتا" delta={data.traffic.visitors} format="count" />
                  <KpiCard title="بازدید صفحات" delta={data.traffic.pageviews} format="count" />
                </div>
              )}
            </div>

            <div>
              <h3 className="mb-3 text-lg font-medium text-neutral-700">
                انطباق فروش با ماتومو{" "}
                <span
                  className="cursor-help text-xs text-neutral-400"
                  title="مقایسه سفارش‌های ثبت‌شده در Strapi (منبع اصلی) با رویدادهای فروش ثبت‌شده در ماتومو — انطباق کامل انتظار نمی‌رود چون ماتومو مرجوعی را کم نمی‌کند و مسدودکننده‌های تبلیغات برخی بازدیدها را نادیده می‌گیرند."
                >
                  (؟)
                </span>
              </h3>
              {reconciliation && reconciliationInfo ? (
                <div className="rounded-2xl border border-neutral-100 bg-white p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-medium ${reconciliationInfo.className}`}
                    >
                      {reconciliationInfo.label}
                    </span>
                    <span className="text-xs text-neutral-500">
                      آخرین بررسی: {reconciliation.bucketDate}
                    </span>
                    {reconciliation.possibleCurrencyMismatch && (
                      <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-700">
                        احتمال ناهماهنگی واحد پول
                      </span>
                    )}
                  </div>
                  <div className="mt-3 flex gap-6 text-xs text-neutral-500">
                    <span>اختلاف تعداد سفارش: {faNum(reconciliation.ordersDelta)}</span>
                    {reconciliation.revenueRatio !== null && (
                      <span>نسبت درآمد: {faNum(reconciliation.revenueRatio.toFixed(2))}</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-neutral-100 bg-white p-5 text-sm text-neutral-500">
                  هنوز داده انطباقی محاسبه نشده است.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </SalesPage>
  );
}
