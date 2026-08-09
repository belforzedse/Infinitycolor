"use client";

import { useEffect, useState } from "react";
import type { LiquidityInterval } from "@/services/super-admin/reports/liquidity";
import { getLiquidity } from "@/services/super-admin/reports/liquidity";
import {
  getGatewayLiquidity,
  type GatewayLiquidityRow,
} from "@/services/super-admin/reports/gatewayLiquidity";
import SalesPage from "../_components/SalesPage";
import { faNum } from "@/utils/faNum";
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
import {
  useReportQueryState,
  parseDateOnly,
} from "@/components/SuperAdmin/reports/shared/useReportQueryState";

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

  const [data, setData] = useState<any>(null);
  const [gatewayRows, setGatewayRows] = useState<GatewayLiquidityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gatewayError, setGatewayError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setGatewayError(null);
    const range = {
      start: parseDateOnly(start).toISOString(),
      end: parseDateOnly(end).toISOString(),
    };
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
          setGatewayRows(gatewayResult.value.rows);
        } else {
          setGatewayRows([]);
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
          <MetricCard
            title="مجموع نقدینگی"
            value={Number(data?.total || 0)}
            format="toman"
          />
          <AdminSection title="روند نقدینگی">
            <LiquidityChart series={data?.series || []} />
          </AdminSection>
          <GatewayLiquiditySection rows={gatewayRows} error={gatewayError} />
        </>
      )}
    </SalesPage>
  );
}

function GatewayLiquiditySection({
  rows,
  error,
}: {
  rows: GatewayLiquidityRow[];
  error: string | null;
}) {
  const sorted = [...rows].sort(
    (left, right) => Number(right.total) - Number(left.total),
  );
  const total = sorted.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const maximum = Math.max(...sorted.map((row) => Number(row.total || 0)), 1);
  return (
    <div id="gateways">
      <AdminSection title="نقدینگی درگاه‌های پرداخت">
        {error ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {error}
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState title="تراکنش موفقی برای تفکیک درگاه‌ها وجود ندارد" />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <MetricCard
                title="مجموع نقدینگی درگاه‌ها"
                value={total}
                format="toman"
              />
              <MetricCard
                title="درگاه‌های فعال"
                value={sorted.filter((row) => Number(row.total) > 0).length}
                format="count"
              />
            </div>
            <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-100 bg-white">
              {sorted.map((row) => {
                const amount = Number(row.total || 0);
                return (
                  <div
                    key={`${row.gatewayId ?? "unknown"}-${row.gatewayTitle}`}
                    className="relative flex items-center justify-between gap-4 overflow-hidden px-4 py-3 text-sm"
                  >
                    <div
                      className="absolute inset-y-0 right-0 bg-infinity-primary/5"
                      style={{
                        width: `${Math.max(0, Math.min(100, (amount / maximum) * 100))}%`,
                      }}
                    />
                    <span className="relative min-w-0 truncate text-slate-700">
                      {row.gatewayTitle}
                    </span>
                    <span className="relative shrink-0 font-semibold text-slate-900">
                      {faNum(amount)} تومان
                    </span>
                  </div>
                );
              })}
            </div>
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

  // Prepare data for Recharts
  const chartData = series.map((item) => ({
    date: new Date(item.bucket).toLocaleDateString("fa-IR", {
      month: "short",
      day: "numeric",
      year: series.length > 30 ? undefined : "numeric",
    }),
    fullDate: new Date(item.bucket).toLocaleDateString("fa-IR"),
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
                tickFormatter={(value) =>
                  `${faNum((value / 1000).toFixed(0))}K`
                }
                stroke="#6b7280"
                fontSize={12}
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
