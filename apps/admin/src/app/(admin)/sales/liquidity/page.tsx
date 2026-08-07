"use client";

import { useEffect, useState } from "react";
import type { LiquidityInterval } from "@/services/super-admin/reports/liquidity";
import { getLiquidity } from "@/services/super-admin/reports/liquidity";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getLiquidity({
      start: parseDateOnly(start).toISOString(),
      end: parseDateOnly(end).toISOString(),
      interval,
    })
      .then((res) => {
        if (active) setData(res);
      })
      .catch((err) => {
        if (active)
          setError(getUserFacingErrorMessage(err, "خطا در بارگذاری نقدینگی"));
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
        </>
      )}
    </SalesPage>
  );
}

function LiquidityChart({ series }: { series: Array<{ bucket: string; total: number }> }) {
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
        <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-lg" dir="rtl">
          <p className="mb-2 font-medium text-neutral-800">{data.fullDate}</p>
          <p className="text-infinity-primary">
            <span className="font-medium">نقدینگی:</span> {faNum(data.total)} تومان
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
            <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="date" stroke="#6b7280" fontSize={12} interval="preserveStartEnd" />
              <YAxis
                tickFormatter={(value) => `${faNum((value / 1000).toFixed(0))}K`}
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
                <linearGradient id="liquidityGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#ec4899" />
                  <stop offset="100%" stopColor="#8b5cf6" />
                </linearGradient>
              </defs>
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Chart legend/info - RTL layout */}
      <div className="text-sm mt-4 flex items-center justify-between text-neutral-600" dir="rtl">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full bg-gradient-to-r from-pink-500 to-purple-500"></div>
          <span>روند نقدینگی</span>
        </div>
        <div className="text-xs text-neutral-500">{series.length} نقطه داده</div>
      </div>
    </div>
  );
}
