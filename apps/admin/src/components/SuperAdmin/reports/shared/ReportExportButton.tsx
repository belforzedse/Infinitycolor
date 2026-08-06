"use client";

import { useState } from "react";

export interface ReportExportButtonProps {
  onExport: () => Promise<void>;
  label?: string;
  loadingLabel?: string;
  errorMessage?: string;
  className?: string;
}

const defaultClassName =
  "rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Shared "دریافت اکسل" button: loading state + a plain-alert failure path, matching
 * the UX every report export already used (products/PerformanceTab, traffic) before
 * this was consolidated. `onExport` is expected to trigger the browser download
 * itself (see downloadProductReportExcel / downloadSalesBreakdownExcel).
 */
export default function ReportExportButton({
  onExport,
  label = "دریافت اکسل",
  loadingLabel = "در حال آماده‌سازی...",
  errorMessage = "خطا در دریافت خروجی اکسل",
  className,
}: ReportExportButtonProps) {
  const [exporting, setExporting] = useState(false);

  const handleClick = async () => {
    try {
      setExporting(true);
      await onExport();
    } catch {
      alert(errorMessage);
    } finally {
      setExporting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={exporting}
      className={className ?? defaultClassName}
    >
      {exporting ? loadingLabel : label}
    </button>
  );
}
