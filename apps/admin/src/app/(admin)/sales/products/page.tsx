"use client";

import SalesPage from "../_components/SalesPage";
import ReportTabs from "@/components/SuperAdmin/reports/shared/ReportTabs";
import { SWAP } from "@/components/SuperAdmin/reports/shared/motion";
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

const TABS: Array<{ id: ReportTab; label: string }> = [
  { id: "overview", label: "نمای کلی" },
  { id: "trends", label: "روند" },
  { id: "performance", label: "عملکرد محصولات" },
  { id: "inventory", label: "موجودی" },
  { id: "payments", label: "پرداخت و ارسال" },
];

export default function ProductReportsPage() {
  // Single source of truth for the report's URL state. Passing `start`/`end`/`filters`
  // down to the tabs as props (instead of each tab subscribing to nuqs independently)
  // guarantees that changing the period — including via the quick-range presets — cascades
  // a re-render to the tabs and refetches immediately.
  const f = useReportFilters();
  const { tab, setTab, start, end, filters } = f;

  return (
    <SalesPage title="گزارش محصولات">
      <div className="space-y-5" dir="rtl">
        <ReportTabs tabs={TABS} value={tab} onChange={setTab} label="بخش‌های گزارش محصولات" idPrefix="products" />

        <FilterBar f={f} showProductFilters={tab === "performance"} />

        <div key={tab} id="products-panel" role="tabpanel" aria-labelledby={`products-tab-${tab}`} className={SWAP}>
          {tab === "overview" && <OverviewTab start={start} end={end} />}
          {tab === "trends" && <TrendsTab start={start} end={end} />}
          {tab === "performance" && <PerformanceTab filters={filters} start={start} end={end} />}
          {tab === "inventory" && <InventoryTab start={start} end={end} />}
          {tab === "payments" && <PaymentShippingTab start={start} end={end} />}
        </div>
      </div>
    </SalesPage>
  );
}
