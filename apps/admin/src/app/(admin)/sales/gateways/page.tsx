"use client";

import { useEffect, useState } from "react";
import { getGatewayLiquidity } from "@/services/super-admin/reports/gatewayLiquidity";
import SalesPage from "../_components/SalesPage";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import {
  AdminSection,
  ChartSkeleton,
  EmptyState,
  ErrorState,
  MetricCard,
  MetricGrid,
} from "@/components/admin";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "@/components/SuperAdmin/reports/shared/charts";
import { useReportQueryState } from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import { faNum } from "@/utils/faNum";

export default function GatewayLiquidityReportPage() {
  // Period comes from the workspace layout's shared nuqs state; this page used
  // to keep it in local useState behind its own pair of zaman pickers.
  const { start, end } = useReportQueryState<never>({ tab: false });
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getGatewayLiquidity({ start, end })
      .then((result) => {
        if (active) setRows(result.rows);
      })
      .catch((err) => {
        if (active)
          setError(
            getUserFacingErrorMessage(err, "خطا در بارگذاری نقدینگی درگاه‌ها"),
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [start, end]);

  const totalLiquidity = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const activeGateways = rows.filter((row) => Number(row.total || 0) > 0).length;

  return (
    <SalesPage title="نقدینگی درگاه‌های پرداخت">
      {error ? (
        <ErrorState description={error} onRetry={() => setError(null)} />
      ) : loading ? (
        <>
          <MetricGrid className="lg:grid-cols-2">
            <MetricCard title="مجموع نقدینگی" loading />
            <MetricCard title="درگاه‌های فعال" loading />
          </MetricGrid>
          <ChartSkeleton />
        </>
      ) : (
        <>
          <MetricGrid className="lg:grid-cols-2">
            <MetricCard
              title="مجموع نقدینگی"
              value={totalLiquidity}
              format="toman"
            />
            <MetricCard
              title="درگاه‌های فعال"
              value={activeGateways}
              format="count"
            />
          </MetricGrid>
          <AdminSection title="توزیع نقدینگی بین درگاه‌های پرداخت">
            <GatewayLiquidityChart rows={rows} />
          </AdminSection>
        </>
      )}
    </SalesPage>
  );
}

function GatewayLiquidityChart({ rows }: { rows: Array<{ gatewayTitle: string; total: number }> }) {
  if (!rows || rows.length === 0) {
    return (
      <EmptyState
        title="داده‌ای برای نمایش یافت نشد"
        description="لطفاً بازه زمانی دیگری انتخاب کنید"
      />
    );
  }

  // Prepare data for Recharts
  const chartData = rows.map((row) => ({
    name: row.gatewayTitle,
    value: Number(row.total),
    percentage: (
      (Number(row.total) / rows.reduce((sum, r) => sum + Number(r.total), 0)) *
      100
    ).toFixed(1),
  }));

  // Colors for different gateways
  const colors = [
    "#8b5cf6", // purple
    "#ec4899", // pink
    "#06b6d4", // cyan
    "#f59e0b", // amber
    "#10b981", // emerald
    "#ef4444", // red
    "#6366f1", // indigo
    "#84cc16", // lime
  ];

  // Custom tooltip
  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-lg" dir="rtl">
          <p className="mb-2 font-medium text-neutral-800">{data.name}</p>
          <div className="text-sm space-y-1">
            <p className="text-purple-600">
              <span className="font-medium">مبلغ:</span> {faNum(data.value)} تومان
            </p>
            <p className="text-neutral-600">
              <span className="font-medium">درصد:</span> {faNum(data.percentage)}%
            </p>
          </div>
        </div>
      );
    }
    return null;
  };

  // Custom label function
  const renderLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }: any) => {
    if (percent < 0.05) return null; // Don't show labels for slices smaller than 5%

    const RADIAN = Math.PI / 180;
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    return (
      <text
        x={x}
        y={y}
        fill="white"
        textAnchor={x > cx ? "start" : "end"}
        dominantBaseline="central"
        fontSize={12}
        fontWeight="bold"
      >
        {`${faNum((percent * 100).toFixed(0))}%`}
      </text>
    );
  };

  return (
    <div className="w-full" dir="rtl">
      <div className="flex flex-col items-center gap-8 lg:flex-row lg:items-start">
        {/* Chart */}
        <div className="w-full min-w-0 lg:w-auto lg:flex-shrink-0">
          <div className="rounded-xl border border-neutral-200 bg-white p-4">
            <div className="h-[280px] w-full max-w-[400px] md:h-[340px] lg:h-[400px] lg:w-[400px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={renderLabel}
                    outerRadius={120}
                    innerRadius={60}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Legend - RTL Layout */}
        <div className="w-full min-w-0 flex-1 lg:w-auto">
          <div className="space-y-3">
            <h4 className="text-sm mb-4 text-right font-medium text-neutral-700">
              درگاه‌های پرداخت
            </h4>
            {chartData.map((item, index) => (
              <div
                key={index}
                className="flex items-center justify-between rounded-lg bg-neutral-50 p-3 transition-colors hover:bg-neutral-100"
                dir="rtl"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div
                    className="h-4 w-4 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: colors[index % colors.length] }}
                  />
                  <div className="min-w-0 flex-1 text-right">
                    <p className="text-sm truncate font-medium text-neutral-700">{item.name}</p>
                    <p className="text-xs text-neutral-500">{faNum(item.percentage)}% از کل</p>
                  </div>
                </div>
                <div className="flex-shrink-0 text-right" dir="ltr">
                  <p className="text-sm font-semibold text-neutral-800">{faNum(item.value)}</p>
                  <p className="text-xs text-neutral-500">تومان</p>
                </div>
              </div>
            ))}
          </div>

          {/* Chart summary - RTL */}
          <div className="mt-6 rounded-lg bg-gradient-to-r from-neutral-50 to-neutral-100 p-4">
            <div className="text-sm flex items-center justify-between" dir="rtl">
              <span className="text-neutral-600">تعداد درگاه‌ها:</span>
              <span className="font-medium text-neutral-800">{faNum(rows.length)} درگاه</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
