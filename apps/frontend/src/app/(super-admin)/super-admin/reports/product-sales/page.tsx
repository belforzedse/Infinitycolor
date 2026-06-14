"use client";

import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import FilterBar from "@/components/SuperAdmin/reports/products/FilterBar";
import OverviewTab from "@/components/SuperAdmin/reports/products/OverviewTab";
import TrendsTab from "@/components/SuperAdmin/reports/products/TrendsTab";
import PerformanceTab from "@/components/SuperAdmin/reports/products/PerformanceTab";
import InventoryTab from "@/components/SuperAdmin/reports/products/InventoryTab";
import PaymentShippingTab from "@/components/SuperAdmin/reports/products/PaymentShippingTab";
import {
  useReportFilters,
  type ReportTab,
} from "@/components/SuperAdmin/reports/products/useReportFilters";

const TABS: Array<{ key: ReportTab; label: string }> = [
  { key: "overview", label: "نمای کلی" },
  { key: "trends", label: "روند" },
  { key: "performance", label: "عملکرد محصولات" },
  { key: "inventory", label: "موجودی" },
  { key: "payments", label: "پرداخت و ارسال" },
];

export default function ProductReportsPage() {
  // Single source of truth for the report's URL state. Passing `start`/`end`/`filters`
  // down to the tabs as props (instead of each tab subscribing to nuqs independently)
  // guarantees that changing the period — including via the quick-range presets — cascades
  // a re-render to the tabs and refetches immediately.
  const f = useReportFilters();
  const { tab, setTab, start, end, filters } = f;

  return (
    <ContentWrapper title="گزارش محصولات">
      <div className="space-y-5" dir="rtl">
        <div className="flex flex-wrap gap-1 rounded-2xl bg-neutral-100 p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.key
                  ? "bg-white text-infinity-primary shadow-sm"
                  : "text-neutral-600 hover:text-neutral-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <FilterBar f={f} showProductFilters={tab === "performance"} />

        {tab === "overview" && <OverviewTab start={start} end={end} />}
        {tab === "trends" && <TrendsTab start={start} end={end} />}
        {tab === "performance" && <PerformanceTab filters={filters} start={start} end={end} />}
        {tab === "inventory" && <InventoryTab start={start} end={end} />}
        {tab === "payments" && <PaymentShippingTab start={start} end={end} />}
      </div>
    </ContentWrapper>
  );
}
