"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { ColumnDef } from "@tanstack/react-table";
import SalesPage from "../_components/SalesPage";
import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import ReportDateRangeField from "@/components/SuperAdmin/reports/shared/ReportDateRangeField";
import ReportExportButton from "@/components/SuperAdmin/reports/shared/ReportExportButton";
import { useReportQueryState } from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import { toDateOnly, parseDateOnly } from "@/components/SuperAdmin/reports/shared/reportDates";
import {
  getSalesBreakdown,
  downloadSalesBreakdownExcel,
  type SalesBreakdownRow,
} from "@/services/super-admin/reports/salesBreakdown";
import { priceFormatter } from "@/utils/price";
import { faNum } from "@/utils/faNum";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";

// `react-iran-maps` uses framer-motion + DOM-measuring tooltips; never SSR.
const ChoroplethMap = dynamic(() => import("react-iran-maps").then((m) => m.ChoroplethMap), {
  ssr: false,
});

// Sequential (one-hue, light->dark) ramp for choropleth magnitude — steps
// 100/250/400/550/700 of the dataviz skill's validated blue sequential ramp.
const MAP_COLORS = ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"];

/** Escapes text interpolated into `renderTooltipContent`'s HTML-string return (non-negotiable per plan). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default function GeographyReportPage() {
  const { start, end, setRange } = useReportQueryState<never>({ tab: false });
  const [data, setData] = useState<SalesBreakdownRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getSalesBreakdown({ dimension: "geography", start, end })
      .then((res) => {
        if (!active) return;
        setData(res.rows);
        setTruncated(res.truncated);
      })
      .catch((err) => {
        if (active) setError(getUserFacingErrorMessage(err, "خطا در بارگذاری گزارش جغرافیایی"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [start, end]);

  // "" is the explicit unmapped/no-address bucket (see salesBreakdown.ts) — it can't
  // be plotted on a province map, but stays in the table and the totals.
  const mappedRows = useMemo(() => data.filter((r) => r.key !== ""), [data]);
  const unmappedRow = useMemo(() => data.find((r) => r.key === ""), [data]);

  const mapData = useMemo(
    () => mappedRows.map((r) => ({ name: r.label, value: r.netToman })),
    [mappedRows],
  );

  const columns = useMemo<ColumnDef<SalesBreakdownRow>[]>(
    () => [
      { accessorKey: "label", header: "استان" },
      {
        accessorKey: "ordersCount",
        header: "سفارش‌ها",
        cell: ({ getValue }) => faNum(getValue() as number),
      },
      {
        accessorKey: "grossToman",
        header: "فروش ناخالص (تومان)",
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
    [],
  );

  return (
    <SalesPage title="گزارش جغرافیایی فروش">
      <div className="space-y-6" dir="rtl">
        <div className="rounded-2xl bg-white p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-medium text-neutral-700">نقشه فروش استان‌ها</h3>
            <ReportExportButton
              onExport={() => downloadSalesBreakdownExcel({ dimension: "geography", start, end })}
            />
          </div>

          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          )}

          {unmappedRow && unmappedRow.ordersCount > 0 && (
            <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
              {faNum(unmappedRow.ordersCount)} سفارش بدون آدرس تحویل قابل‌شناسایی (استان نامشخص) — در نقشه
              نمایش داده نمی‌شود، اما در جدول زیر و مجموع فروش لحاظ شده است.
            </div>
          )}
          {truncated && (
            <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
              تعداد استان‌ها بیشتر از حد نمایش است؛ کمترین موارد در ردیف «سایر» جمع شده‌اند.
            </div>
          )}

          {!loading && mapData.length > 0 && (
            <div className="mx-auto mb-6 max-w-2xl">
              <ChoroplethMap
                data={mapData}
                legend={{ mode: "quantitative", colors: MAP_COLORS }}
                renderTooltipContent={(provinceData) => {
                  if (!provinceData) return "";
                  const name = escapeHtml(provinceData.name);
                  const valueText =
                    typeof provinceData.value === "number" ? priceFormatter(provinceData.value) : "";
                  return `<div style="text-align:right;direction:rtl;padding:8px;"><strong>${name}</strong><br/>خالص فروش: ${escapeHtml(valueText)} تومان</div>`;
                }}
              />
            </div>
          )}

          <p className="mb-3 text-xs text-neutral-500">
            نقشه جنبه نمایشی دارد؛ جدول زیر منبع اصلی و کامل داده است (شامل سفارش‌های بدون استان
            مشخص). داده در سطح استان است؛ تفکیک شهرستان در این نسخه پیاده‌سازی نشده است.
          </p>
          <SuperAdminTable columns={columns} data={data} loading={loading} />
        </div>
      </div>
    </SalesPage>
  );
}
