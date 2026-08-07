import { ChartSkeleton, MetricGridSkeleton } from "@/components/admin";

/**
 * Route-level fallback for the Sales workspace. The layout (header, section
 * navigation, date range) stays mounted across these transitions, so only the
 * subpage body needs a placeholder — and it is shaped like the metrics and
 * chart that follow rather than being a full-page spinner.
 */
export default function SalesLoading() {
  return (
    <div className="space-y-4 lg:space-y-6" aria-busy>
      <MetricGridSkeleton count={6} />
      <ChartSkeleton />
    </div>
  );
}
