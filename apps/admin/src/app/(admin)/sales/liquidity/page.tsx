"use client";

import { useEffect, useState } from "react";
import type {
  LiquidityInterval,
  LiquidityResult,
} from "@/services/super-admin/reports/liquidity";
import { getLiquidity } from "@/services/super-admin/reports/liquidity";
import {
  getGatewayLiquidity,
  type GatewayLiquidityResult,
} from "@/services/super-admin/reports/gatewayLiquidity";
import SalesPage from "../_components/SalesPage";
import { faNum } from "@/utils/faNum";
import { compactToman } from "@/utils/price";
import GatewayBreakdownTable from "@/components/SuperAdmin/reports/shared/GatewayBreakdownTable";
import MetricFormula from "@/components/SuperAdmin/reports/shared/MetricFormula";
import ReportNotes from "@/components/SuperAdmin/reports/products/ReportNotes";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import {
  AdminSection,
  ChartSkeleton,
  EmptyState,
  ErrorState,
  MetricCard,
} from "@/components/admin";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "@/components/SuperAdmin/reports/shared/charts";
import { useReportQueryState } from "@/components/SuperAdmin/reports/shared/useReportQueryState";

const INTERVAL_OPTIONS: { id: LiquidityInterval; label: string }[] = [
  { id: "day", label: "روزانه" },
  { id: "week", label: "هفتگی" },
  { id: "month", label: "ماهانه" },
];

export default function LiquidityReportPage() {
  // The period now comes from the workspace layout via shared nuqs state, so it
  // survives navigation between sales subpages and is shareable as a URL. This
  // page previously kept it in local useState with its own zaman pickers.
  const { start, end, values, setValues } = useReportQueryState<"interval">({
    tab: false,
    extraKeys: ["interval"],
  });
  const interval = (values.interval || "day") as LiquidityInterval;

  const [data, setData] = useState<LiquidityResult | null>(null);
  const [gateways, setGateways] = useState<GatewayLiquidityResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gatewayError, setGatewayError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setGatewayError(null);
    const range = { start, end };
    Promise.allSettled([
      getLiquidity({ ...range, interval }),
      getGatewayLiquidity(range),
    ])
      .then(([liquidityResult, gatewayResult]) => {
        if (!active) return;
        if (liquidityResult.status === "fulfilled") {
          setData(liquidityResult.value);
        } else {
          setError(
            getUserFacingErrorMessage(
              liquidityResult.reason,
              "خطا در بارگذاری نقدینگی",
            ),
          );
        }
        if (gatewayResult.status === "fulfilled") {
          setGateways(gatewayResult.value);
        } else {
          setGateways(null);
          setGatewayError(
            getUserFacingErrorMessage(
              gatewayResult.reason,
              "تفکیک درگاه‌ها در دسترس نیست",
            ),
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [start, end, interval]);

  return (
    <SalesPage
      title="مجموع نقدینگی"
      actions={
        <div className="flex items-center gap-2">
          <label
            className="text-xs shrink-0 text-neutral-500"
            htmlFor="liquidity-interval"
          >
            بازه زمانی
          </label>
          <select
            id="liquidity-interval"
            className="text-sm h-11 rounded-lg border border-neutral-300 bg-white px-3 focus:border-transparent focus:ring-2 focus:ring-infinity-primary md:h-10"
            value={interval}
            onChange={(e) => setValues({ interval: e.target.value, page: "1" })}
          >
            {INTERVAL_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {error ? (
        <ErrorState description={error} onRetry={() => setError(null)} />
      ) : loading ? (
        <>
          <MetricCard title="مجموع نقدینگی" loading />
          <ChartSkeleton />
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <MetricCard
              title="مجموع نقدینگی"
              value={Number(data?.total || 0)}
              format="toman"
              footer="پول واقعی دریافتی سفارش‌های پرداخت‌شده بر پایه تاریخ پرداخت: شامل هزینه ارسال و خالص از مرجوعی. با «فروش ناخالص» در نمای کلی فروش برابر نیست؛ آن رقم هم هزینه ارسال را دارد اما پیش از کسر تخفیف و بر پایه تاریخ ثبت سفارش است."
            />
            <MetricCard
              title="سفارش‌های پرداخت‌شده"
              value={Number(data?.ordersCount || 0)}
              format="count"
            />
          </div>
          {data?.ordersDefinition === "completed" && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              در این بازه هیچ تراکنش موفق درگاهی ثبت نشده است، بنابراین ارقام بر پایه سفارش‌های
              «در حال انجام یا تحویل‌شده» محاسبه شده و مبالغ تسویه‌نشده صفر در نظر گرفته شده‌اند.
            </p>
          )}
          <AdminSection
            title="روند نقدینگی"
            description="بر پایه تاریخ پرداخت است، نه تاریخ ثبت سفارش؛ همان سری «روند» گزارش محصولات با ساعت پرداخت."
          >
            <LiquidityChart series={data?.series || []} />
          </AdminSection>
          <GatewayLiquiditySection data={gateways} error={gatewayError} />
        </>
      )}
    </SalesPage>
  );
}

function GatewayLiquiditySection({
  data,
  error,
}: {
  data: GatewayLiquidityResult | null;
  error: string | null;
}) {
  const rows = data?.rows ?? [];
  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  // `undefined` = the API does not send the term yet; `0` = shipping really was
  // free. Only the second can be put in an equation.
  //
  // `shipping <= total` is the other guard: on a window that fell back to the
  // "completed" definition there is no settled cash at all, so `total` is 0 (or
  // below shipping) and the subtraction would render a negative «فروش کالا».
  // The amber banner above already explains that window; an impossible identity
  // would only muddy it.
  const shipping = data?.shippingRevenue;
  const canReconcile =
    typeof shipping === "number" &&
    Number.isFinite(shipping) &&
    total > 0 &&
    shipping <= total;
  return (
    <div id="gateways">
      <AdminSection
        title="دریافتی درگاه‌های پرداخت"
        description="همان جدول «پرداخت و ارسال» گزارش محصولات؛ سفارش‌های ترکیبی (کیف پول + درگاه) زیر هر دو کانال دیده می‌شوند."
      >
        {error ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {error}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title="تراکنش موفقی برای تفکیک درگاه‌ها وجود ندارد" />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <MetricCard title="مجموع دریافتی درگاه‌ها" value={total} format="toman" />
              <MetricCard
                title="درگاه‌های فعال"
                value={rows.filter((row) => Number(row.total) > 0).length}
                format="count"
              />
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-100 bg-white p-4">
              <GatewayBreakdownTable
                rows={rows}
                totalSales={total}
                ordersCount={data?.paidOrdersCount ?? 0}
              />
            </div>
            {/*
              Both terms come from this one endpoint and the one `paid_orders`
              set, so the arithmetic is exact. The relationship to «فروش ناخالص»
              on the overview is NOT exact — it is counted on the order date —
              so it stays in the note, out of the equation.
            */}
            {canReconcile && (
              <MetricFormula
                terms={[
                  { label: "مجموع دریافتی درگاه‌ها", value: total },
                  { label: "هزینه ارسال", value: shipping, op: "−" },
                ]}
                result={{ label: "فروش کالا (بدون ارسال)", value: total - shipping }}
                note={
                  <>
                    «دریافتی درگاه‌ها» پولی است که واقعاً در درگاه نشسته، پس هزینه ارسال را هم در بر
                    می‌گیرد؛ «فروش ناخالص» در «نمای کلی فروش» هم هزینه ارسال را دارد، اما پیش از کسر
                    تخفیف است. رقم سمت راست این تساوی، فروش کالا بدون ارسال، همان چیزی است که با
                    «فروش خالص» آن صفحه سنجیده می‌شود. این دو بر پایه دو تاریخ متفاوت شمرده می‌شوند
                    — اینجا تاریخ پرداخت، آنجا تاریخ ثبت سفارش — بنابراین سفارشی که پرداختش به بازه
                    بعد افتاده، تفاوت کوچکی باقی می‌گذارد.
                  </>
                }
              />
            )}
            <ReportNotes warnings={data?.dataQualityWarnings} />
          </div>
        )}
      </AdminSection>
    </div>
  );
}

function LiquidityChart({
  series,
}: {
  series: Array<{ bucket: string; total: number }>;
}) {
  if (!series || series.length === 0) {
    return (
      <EmptyState
        title="داده‌ای برای نمایش یافت نشد"
        description="لطفاً بازه زمانی دیگری انتخاب کنید"
      />
    );
  }

  // Bucket keys are Tehran calendar dates (`YYYY-MM-DD`); anchor them at
  // Tehran noon so the label never slips a day in another browser zone.
  const bucketDate = (bucket: string) => new Date(`${bucket}T12:00:00+03:30`);
  const chartData = series.map((item) => ({
    date: bucketDate(item.bucket).toLocaleDateString("fa-IR", {
      month: "short",
      day: "numeric",
      year: series.length > 30 ? undefined : "numeric",
    }),
    fullDate: bucketDate(item.bucket).toLocaleDateString("fa-IR"),
    total: Number(item.total),
    bucket: item.bucket,
  }));

  // Custom tooltip
  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div
          className="rounded-lg border border-neutral-200 bg-white p-4 shadow-lg"
          dir="rtl"
        >
          <p className="mb-2 font-medium text-neutral-800">{data.fullDate}</p>
          <p className="text-infinity-primary">
            <span className="font-medium">نقدینگی:</span> {faNum(data.total)}{" "}
            تومان
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="w-full" dir="rtl">
      <div className="rounded-xl border border-neutral-200 bg-white p-2 md:p-4">
        {/* Charts get a shorter box on phones so the summary above stays visible. */}
        <div className="h-[260px] md:h-[340px] lg:h-[400px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              margin={{ top: 20, right: 30, left: 20, bottom: 20 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis
                dataKey="date"
                stroke="#6b7280"
                fontSize={12}
                interval="preserveStartEnd"
              />
              <YAxis
                tickFormatter={(value) => compactToman(Number(value))}
                stroke="#6b7280"
                fontSize={12}
                width={64}
              />
              <Tooltip content={<CustomTooltip />} />
              <Line
                type="monotone"
                dataKey="total"
                stroke="url(#liquidityGradient)"
                strokeWidth={3}
                dot={{ fill: "#ec4899", strokeWidth: 2, r: 4 }}
                activeDot={{
                  r: 6,
                  stroke: "#ec4899",
                  strokeWidth: 2,
                  fill: "#fff",
                }}
              />
              <defs>
                <linearGradient
                  id="liquidityGradient"
                  x1="0%"
                  y1="0%"
                  x2="100%"
                  y2="0%"
                >
                  <stop offset="0%" stopColor="#ec4899" />
                  <stop offset="100%" stopColor="#8b5cf6" />
                </linearGradient>
              </defs>
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Chart legend/info - RTL layout */}
      <div
        className="text-sm mt-4 flex items-center justify-between text-neutral-600"
        dir="rtl"
      >
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full bg-gradient-to-r from-pink-500 to-purple-500"></div>
          <span>روند نقدینگی</span>
        </div>
        <div className="text-xs text-neutral-500">
          {series.length} نقطه داده
        </div>
      </div>
    </div>
  );
}
