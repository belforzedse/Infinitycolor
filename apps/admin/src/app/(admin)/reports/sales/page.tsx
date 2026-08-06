"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import ReportDateRangeField from "@/components/SuperAdmin/reports/shared/ReportDateRangeField";
import ReportExportButton from "@/components/SuperAdmin/reports/shared/ReportExportButton";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  REPORT_CHART_COLORS,
} from "@/components/SuperAdmin/reports/shared/charts";
import {
  useReportQueryState,
  toDateOnly,
  parseDateOnly,
} from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import {
  getSalesBreakdown,
  downloadSalesBreakdownExcel,
  SALES_BREAKDOWN_DIMENSIONS,
  type SalesBreakdownDimension,
  type SalesBreakdownResponse,
} from "@/services/super-admin/reports/salesBreakdown";
import { priceFormatter } from "@/utils/price";
import { faNum } from "@/utils/faNum";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";

const DIMENSION_LABELS: Record<SalesBreakdownDimension, string> = {
  status: "وضعیت سفارش",
  category: "دسته‌بندی",
  customer: "مشتری",
  coupon: "کد تخفیف",
  geography: "استان",
};

const CHART_TOP_N = 8;

export default function SalesBreakdownReportPage() {
  const { start, end, tab, setTab, setRange } = useReportQueryState<never>({
    tab: { defaultValue: "status" },
  });
  const dimension = (tab as SalesBreakdownDimension) || "status";

  const [data, setData] = useState<SalesBreakdownResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getSalesBreakdown({ dimension, start, end })
      .then((res) => {
        if (active) setData(res);
      })
      .catch((err) => {
        if (active) setError(getUserFacingErrorMessage(err, "خطا در بارگذاری گزارش فروش"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [dimension, start, end]);

  const columns = useMemo<ColumnDef<SalesBreakdownResponse["rows"][number]>[]>(
    () => [
      { accessorKey: "label", header: DIMENSION_LABELS[dimension] },
      {
        accessorKey: "ordersCount",
        header: "سفارش‌ها",
        cell: ({ getValue }) => faNum(getValue() as number),
      },
      {
        accessorKey: "units",
        header: "تعداد",
        cell: ({ getValue }) => faNum(getValue() as number),
      },
      {
        accessorKey: "grossToman",
        header: "فروش ناخالص (تومان)",
        cell: ({ getValue }) => priceFormatter(getValue() as number),
      },
      {
        accessorKey: "discountsToman",
        header: "تخفیف (تومان)",
        cell: ({ getValue }) => priceFormatter(getValue() as number),
      },
      {
        accessorKey: "refundsToman",
        header: "مرجوعی (تومان)",
        cell: ({ getValue }) => priceFormatter(getValue() as number),
      },
      {
        accessorKey: "netToman",
        header: "خالص فروش (تومان)",
        cell: ({ getValue }) => priceFormatter(getValue() as number),
      },
    ],
    [dimension],
  );

  const chartData = useMemo(
    () => (data?.rows ?? []).slice(0, CHART_TOP_N).map((r) => ({ name: r.label, net: r.netToman })),
    [data],
  );

  return (
    <ContentWrapper title="فروش بر اساس وضعیت / دسته‌بندی / مشتری / کوپن / استان">
      <div className="space-y-6" dir="rtl">
        <div className="rounded-2xl bg-white p-5">
          <p className="text-xs text-neutral-500">
            برای فروش بر اساس تاریخ، محصول، مدل یا درگاه پرداخت به{" "}
            <Link href="/reports/product-sales" className="text-infinity-primary hover:underline">
              گزارش فروش هر محصول
            </Link>{" "}
            مراجعه کنید.
          </p>
        </div>

        <div className="rounded-2xl bg-white p-5">
          <h3 className="mb-4 text-lg font-medium text-neutral-700">بازه گزارش</h3>
          <ReportDateRangeField
            start={parseDateOnly(start)}
            end={parseDateOnly(end)}
            onChange={(range) =>
              setRange({
                start: toDateOnly(range.start),
                end: toDateOnly(range.end),
              })
            }
          />
        </div>

        <div className="rounded-2xl bg-white p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {SALES_BREAKDOWN_DIMENSIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setTab?.(d)}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                    dimension === d
                      ? "bg-infinity-primary text-white"
                      : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                  }`}
                >
                  {DIMENSION_LABELS[d]}
                </button>
              ))}
            </div>
            <ReportExportButton
              onExport={() => downloadSalesBreakdownExcel({ dimension, start, end })}
            />
          </div>

          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          )}

          {data?.truncated && (
            <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
              تعداد ردیف‌ها زیاد است؛ کمترین موارد در ردیف «سایر» جمع شده‌اند.
            </div>
          )}

          {!loading && chartData.length > 0 && (
            <div className="mb-6 h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v: number) => faNum(v)} />
                  <Tooltip formatter={((v: number) => priceFormatter(Number(v))) as any} />
                  <Bar dataKey="net" radius={[4, 4, 0, 0]}>
                    {chartData.map((entry, i) => (
                      <Cell key={entry.name} fill={REPORT_CHART_COLORS[i % REPORT_CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <SuperAdminTable columns={columns} data={data?.rows ?? []} loading={loading} />
        </div>
      </div>
    </ContentWrapper>
  );
}
