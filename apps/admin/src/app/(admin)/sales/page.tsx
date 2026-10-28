"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SalesPage from "./_components/SalesPage";
import { AdminCard } from "@/components/admin";
import KpiCard, { periodFigure, type PeriodDelta } from "@/components/SuperAdmin/reports/shared/KpiCard";
import WeeklyHeatmap from "@/components/SuperAdmin/reports/shared/WeeklyHeatmap";
import { numberText, tehranToday, tomanText } from "@/components/SuperAdmin/reports/shared/format";
import { NO_COMPARISON_BEFORE_FLOOR, previousWasClipped } from "@/components/SuperAdmin/reports/shared/salesSeries";
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
  // The server cuts the previous window at the storefront cutover; a clipped
  // window holds fewer days, so its change would mislead.
  const comparable = Boolean(data && !previousWasClipped(data.range, data.previous));
  const incomplete = end >= tehranToday();
  type SeriesKey = "gross" | "shipping" | "net" | "orders" | "units" | "discounts" | "refunds";
  const spark = (key: SeriesKey) => data?.series?.points.map((point) => point[key]) ?? null;
  const figure = (
    delta: PeriodDelta | undefined,
    money: boolean,
    options: { lowerIsBetter?: boolean; neutral?: boolean } = {},
  ) =>
    periodFigure(delta, {
      format: money ? tomanText : (value) => numberText(value),
      comparable,
      noComparisonText: NO_COMPARISON_BEFORE_FLOOR,
      ...options,
    });

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
              <KpiCard title="فروش ناخالص" loading />
              <KpiCard title="هزینه ارسال" loading />
              <KpiCard title="فروش خالص" loading />
              <KpiCard title="سفارش‌ها" loading />
              <KpiCard title="تعداد فروش" loading />
              <KpiCard title="تخفیف‌ها" loading />
              <KpiCard title="مرجوعی‌ها" loading />
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
                  {...figure(data.sales.gross, true)}
                  spark={spark("gross")}
                  incomplete={incomplete}
                  info={
                    shipping
                      ? "مبلغ کل سفارش‌های پرداخت‌شده پیش از کسر تخفیف: اقلام سفارش به‌علاوه هزینه ارسال. در گزارش محصولات «فروش ناخالص محصولات» فقط اقلام است، چون هزینه ارسال به هیچ محصولی تعلق ندارد."
                      : "مجموع مبلغ اقلام سفارش‌های پرداخت‌شده، پیش از تخفیف و بدون هزینه ارسال."
                  }
                  order={0}
                />
                {shipping && (
                  <KpiCard
                    title="هزینه ارسال"
                    {...figure(shipping, true, { neutral: true })}
                    spark={spark("shipping")}
                    incomplete={incomplete}
                    info="مجموع هزینه ارسالی که از مشتری گرفته شده است؛ در «فروش ناخالص» هست و از «فروش خالص» کسر شده."
                    order={1}
                  />
                )}
                <KpiCard
                  title="فروش خالص"
                  {...figure(data.sales.net, true)}
                  spark={spark("net")}
                  incomplete={incomplete}
                  info="فروش کالا پس از کسر تخفیف و مرجوعی؛ هزینه ارسال در این رقم نیست."
                  order={2}
                />
                <KpiCard
                  title="سفارش‌ها"
                  {...figure(data.sales.orders, false)}
                  spark={spark("orders")}
                  incomplete={incomplete}
                  order={3}
                />
                <KpiCard
                  title="تعداد فروش"
                  {...figure(data.sales.units, false)}
                  spark={spark("units")}
                  incomplete={incomplete}
                  order={4}
                />
                <KpiCard
                  title="تخفیف‌ها"
                  {...figure(data.sales.discounts, true, { neutral: true })}
                  spark={spark("discounts")}
                  order={5}
                />
                <KpiCard
                  title="مرجوعی‌ها"
                  {...figure(data.sales.refunds, true, { lowerIsBetter: true })}
                  spark={spark("refunds")}
                  order={6}
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
            {data.weekly ? (
              <AdminCard>
                <WeeklyHeatmap
                  value={data.weekly}
                  id="orders-weekly-title"
                  title="ساعت‌های خرید"
                  unit="سفارش پرداخت‌شده"
                  intro="میانگین سفارش‌های پرداخت‌شده در هر ساعت، به وقت تهران و بر پایه زمان ثبت سفارش."
                />
              </AdminCard>
            ) : null}
          </>
        )}
      </div>
    </SalesPage>
  );
}
