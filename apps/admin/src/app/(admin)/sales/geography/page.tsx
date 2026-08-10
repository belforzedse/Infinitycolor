"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import SalesPage from "../_components/SalesPage";
import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import ReportExportButton from "@/components/SuperAdmin/reports/shared/ReportExportButton";
import SalesGeographyMap from "@/components/SuperAdmin/reports/shared/SalesGeographyMap";
import { useReportQueryState } from "@/components/SuperAdmin/reports/shared/useReportQueryState";
import {
  getSalesBreakdown,
  downloadSalesBreakdownExcel,
  type SalesBreakdownRow,
} from "@/services/super-admin/reports/salesBreakdown";
import { priceFormatter } from "@/utils/price";
import { faNum } from "@/utils/faNum";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";

/**
 * Dedicated geography route kept for parity with legacy bookmarks.
 * Production traffic is redirected to `/sales/breakdown?tab=geography`, which
 * renders the same map via `SalesGeographyMap`.
 */
export default function GeographyReportPage() {
  const { start, end } = useReportQueryState<never>({ tab: false });
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
        if (active)
          setError(getUserFacingErrorMessage(err, "خطا در بارگذاری گزارش جغرافیایی"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [start, end]);

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
    <SalesPage
      title="گزارش جغرافیایی فروش"
      description="فروش خالص را روی نقشه استان‌ها ببینید؛ جدول زیر منبع کامل داده است."
      actions={
        <ReportExportButton
          onExport={() => downloadSalesBreakdownExcel({ dimension: "geography", start, end })}
        />
      }
    >
      <div className="space-y-6" dir="rtl">
        <div className="rounded-2xl bg-white p-5">
          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {truncated && (
            <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
              تعداد استان‌ها بیشتر از حد نمایش است؛ کمترین موارد در ردیف «سایر» جمع شده‌اند.
            </div>
          )}

          {!loading ? <SalesGeographyMap rows={data} /> : null}

          <SuperAdminTable columns={columns} data={data} loading={loading} />
        </div>
      </div>
    </SalesPage>
  );
}
