"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SalesPage from "./_components/SalesPage";
import KpiCard from "@/components/SuperAdmin/reports/products/KpiCard";
import { useReportQueryState } from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import {
  getOverview,
  type OverviewResponse,
} from "@/services/super-admin/reports/overview";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";

export default function OverviewReportPage() {
  const { start, end } = useReportQueryState<never>({ tab: false });
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
        if (active)
          setError(getUserFacingErrorMessage(err, "خطا در بارگذاری نمای کلی"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [start, end]);

  return (
    <SalesPage title="نمای کلی فروش">
      <div className="space-y-6" dir="rtl">
        {error && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
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
              <h3 className="mb-3 text-lg font-medium text-neutral-700">
                فروش
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <KpiCard
                  title="فروش ناخالص"
                  delta={data.sales.gross}
                  format="toman"
                />
                <KpiCard
                  title="فروش خالص"
                  delta={data.sales.net}
                  format="toman"
                />
                <KpiCard
                  title="سفارش‌ها"
                  delta={data.sales.orders}
                  format="count"
                />
                <KpiCard
                  title="تعداد فروش"
                  delta={data.sales.units}
                  format="count"
                />
                <KpiCard
                  title="تخفیف‌ها"
                  delta={data.sales.discounts}
                  format="toman"
                />
                <KpiCard
                  title="مرجوعی‌ها"
                  delta={data.sales.refunds}
                  format="toman"
                />
              </div>
              <Link
                href="/sales/breakdown"
                className="mt-3 inline-block text-xs text-infinity-primary hover:underline"
              >
                مشاهده تفکیک فروش بر اساس وضعیت، دسته‌بندی، مشتری، کوپن و استان
                ←
              </Link>
            </div>

            <div>
              <h3 className="mb-3 text-lg font-medium text-neutral-700">
                وضعیت ثبت آمار خرید و مرجوعی
              </h3>
              {data.analyticsDelivery ? (
                <div
                  className={`rounded-2xl border p-5 ${data.analyticsDelivery.status === "healthy" ? "border-emerald-100 bg-emerald-50" : data.analyticsDelivery.status === "attention" ? "border-rose-100 bg-rose-50" : "border-amber-100 bg-amber-50"}`}
                >
                  <p className="text-sm font-medium text-slate-800">
                    {data.analyticsDelivery.status === "healthy"
                      ? "همه خریدها و مرجوعی‌ها در آمار ثبت شده‌اند"
                      : data.analyticsDelivery.status === "attention"
                        ? "ثبت بعضی خریدها یا مرجوعی‌ها نیازمند بررسی است"
                        : "بعضی خریدها یا مرجوعی‌ها هنوز در انتظار ثبت هستند"}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-600">
                    <span>
                      منتظر ثبت:{" "}
                      {data.analyticsDelivery.pending.toLocaleString("fa-IR")}
                    </span>
                    <span>
                      در حال ثبت:{" "}
                      {data.analyticsDelivery.processing.toLocaleString(
                        "fa-IR",
                      )}
                    </span>
                    <span>
                      نیازمند بررسی:{" "}
                      {data.analyticsDelivery.deadLetter.toLocaleString(
                        "fa-IR",
                      )}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-neutral-100 bg-white p-5 text-sm text-neutral-500">
                  وضعیت ثبت آمار خرید و مرجوعی در دسترس نیست.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </SalesPage>
  );
}
