"use client";

import { cn } from "@/utils/tailwind";
import { faNum } from "@/utils/faNum";
import { priceFormatter } from "@/utils/price";
import { CARD } from "./tokens";
import { MetricCardSkeleton } from "./skeletons";

export type MetricFormat = "toman" | "count" | "percent" | "raw";

export type MetricDelta = {
  current: number;
  previous: number;
  change: number;
  changePct: number | null;
};

export function formatMetric(value: number, format: MetricFormat) {
  switch (format) {
    case "toman":
      return priceFormatter(Math.round(value), " تومان");
    case "percent":
      return `${faNum(Math.round(value))}٪`;
    case "raw":
      return String(value);
    case "count":
    default:
      return faNum(Math.round(value));
  }
}

/**
 * One metric tile for the whole admin. Consolidates three separate designs:
 * the reports KpiCard, a private MetricCard inside the traffic page, and
 * inline tiles on the dashboard.
 *
 * Accepts either a plain `value` or a `delta` (current vs previous period).
 * The delta shape and its period-over-period presentation are carried over
 * unchanged from KpiCard so analytics keep reading identically.
 */
export default function MetricCard({
  title,
  value,
  delta,
  format = "count",
  tooltip,
  estimate,
  loading,
  footer,
  className,
}: {
  title: string;
  value?: number;
  delta?: MetricDelta;
  format?: MetricFormat;
  tooltip?: string;
  /** Marks a value derived by apportioning rather than measured directly. */
  estimate?: boolean;
  loading?: boolean;
  footer?: React.ReactNode;
  className?: string;
}) {
  if (loading || (!delta && value === undefined)) {
    return <MetricCardSkeleton />;
  }

  const current = delta ? delta.current : (value as number);
  const up = delta ? delta.change > 0 : false;
  const down = delta ? delta.change < 0 : false;
  const changeColor = up
    ? "text-green-600"
    : down
      ? "text-red-600"
      : "text-neutral-400";
  const arrow = up ? "↑" : down ? "↓" : "•";

  return (
    <div className={cn(CARD, "p-4 md:p-5", className)} dir="rtl">
      <div className="mb-2 flex min-w-0 items-center gap-1.5">
        <h3 className="text-sm min-w-0 break-words font-medium text-neutral-500">
          {title}
        </h3>
        {estimate && (
          <span
            className="text-[10px] shrink-0 rounded-md bg-amber-50 px-1.5 py-0.5 font-medium text-amber-600"
            title="این مقدار تخمینی است (تسهیم در سطح قلم)"
          >
            تخمینی
          </span>
        )}
        {tooltip && (
          <span
            className="text-[10px] flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full bg-neutral-100 text-neutral-500"
            title={tooltip}
          >
            ؟
          </span>
        )}
      </div>

      <p className="text-xl font-bold text-neutral-800 md:text-2xl">
        <span className="break-words">{formatMetric(current, format)}</span>
      </p>

      {delta && (
        <div className="text-xs mt-3 flex flex-wrap items-center gap-2">
          <span className={cn("font-medium", changeColor)}>
            {arrow}{" "}
            {delta.changePct === null
              ? "—"
              : `${faNum(Math.abs(delta.changePct))}٪`}
          </span>
          <span className="text-neutral-400">
            دوره قبل: {formatMetric(delta.previous, format)}
          </span>
        </div>
      )}

      {footer && <div className="text-xs mt-3 text-neutral-400">{footer}</div>}
    </div>
  );
}

export function MetricGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {children}
    </div>
  );
}
