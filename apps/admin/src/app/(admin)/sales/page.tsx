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
import MetricFormula from "@/components/SuperAdmin/reports/shared/MetricFormula";
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

  // Absent against an API image older than decision D16, whose gross is still
  // line-only — so its absence switches the page back to the three-term identity
  // rather than rendering a missing term. Admin and API deploy as separate images.
  const shipping = data?.sales.shipping;

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
              <KpiCard title="هزینه ارسال" format="toman" loading />
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
                  tooltip={
                    shipping
                      ? "مبلغ کل سفارش‌های پرداخت‌شده پیش از کسر تخفیف: اقلام سفارش به‌علاوه هزینه ارسال. در گزارش محصولات «فروش ناخالص محصولات» فقط اقلام است، چون هزینه ارسال به هیچ محصولی تعلق ندارد."
                      : "مجموع مبلغ اقلام سفارش‌های پرداخت‌شده، پیش از تخفیف و بدون هزینه ارسال"
                  }
                />
                {shipping && (
                  <KpiCard
                    title="هزینه ارسال"
                    delta={shipping}
                    format="toman"
                    tooltip="مجموع هزینه ارسالی که از مشتری گرفته شده است؛ در «فروش ناخالص» هست و از «فروش خالص» کسر شده."
                  />
                )}
                <KpiCard
                  title="فروش خالص"
                  delta={data.sales.net}
                  format="toman"
                  tooltip="فروش کالا پس از کسر تخفیف و مرجوعی؛ هزینه ارسال در این رقم نیست"
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
              {/*
                Every term is from this one `overview` payload, so the equality
                holds exactly. «فروش ناخالص» here carries the delivery fee, so the
                identity has to hand it back before reaching the merchandise-only
                «فروش خالص» — that subtraction is the whole reason the term is
                spelled out. The link to نقدینگی stays prose and not an equation:
                that page counts on the payment date, this one on the order date.
              */}
              <MetricFormula
                className="mt-3"
                terms={[
                  { label: "فروش ناخالص", value: data.sales.gross.current },
                  ...(shipping
                    ? ([
                        { label: "هزینه ارسال", value: shipping.current, op: "−" },
                      ] as const)
                    : []),
                  { label: "تخفیف‌ها", value: data.sales.discounts.current, op: "−" },
                  { label: "مرجوعی‌ها", value: data.sales.refunds.current, op: "−" },
                ]}
                result={{ label: "فروش خالص", value: data.sales.net.current }}
                note={
                  <>
                    {shipping ? (
                      <>
                        «فروش ناخالص» مبلغ کل سفارش پیش از کسر تخفیف است: اقلام به‌علاوه هزینه
                        ارسال. «فروش خالص» فقط فروش کالاست و هزینه ارسال در آن نیست.{" "}
                      </>
                    ) : (
                      <>هیچ‌کدام از این ارقام هزینه ارسال را در بر نمی‌گیرند. </>
                    )}
                    همه بر پایه تاریخ ثبت سفارش شمرده می‌شوند. «مجموع دریافتی درگاه‌ها» در{" "}
                    <Link
                      href="/sales/liquidity#gateways"
                      className="text-infinity-primary hover:underline"
                    >
                      صفحه نقدینگی
                    </Link>{" "}
                    پول واقعی دریافتی است، یعنی تقریباً{" "}
                    {shipping
                      ? "همین فروش ناخالص منهای تخفیف و مرجوعی"
                      : "همین فروش خالص به‌علاوه هزینه ارسال"}{" "}
                    — و بر پایه تاریخ پرداخت، پس در سفارش‌های مرز بازه اندکی تفاوت می‌کند.
                  </>
                }
              />
              <Link
                href="/sales/breakdown"
                className="mt-3 inline-block text-xs text-infinity-primary hover:underline"
              >
                مشاهده تفکیک فروش بر اساس وضعیت، دسته‌بندی، مشتری، کوپن و استان
                ←
              </Link>
            </div>
          </>
        )}
      </div>
    </SalesPage>
  );
}
