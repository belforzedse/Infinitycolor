"use client";

import { cn } from "@/utils/tailwind";
import { FOCUS_RING } from "@/components/admin";

/** Swaps a chart for its exact-values table and back. */
export function ChartTableToggle({
  showing,
  onToggle,
  controls,
}: {
  showing: boolean;
  onToggle: () => void;
  controls?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={showing}
      aria-controls={controls}
      className={cn(
        "rounded-control border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50",
        FOCUS_RING,
      )}
    >
      {showing ? "نمایش نمودار" : "نمایش جدول"}
    </button>
  );
}
