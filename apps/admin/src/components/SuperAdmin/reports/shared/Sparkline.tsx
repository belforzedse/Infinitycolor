"use client";

import { cn } from "@/utils/tailwind";
import { SERIES_COLOR } from "./chartTheme";
import { useEntered } from "./motion";

/**
 * A 12–60 point trend line drawn as plain SVG (no chart runtime). The stroke
 * draws itself in once. Decorative: the same numbers are in the page's chart
 * or table view, so it is hidden from assistive technology.
 */
export function Sparkline({
  values,
  className,
  width = 96,
  height = 28,
}: {
  values: ReadonlyArray<number | null>;
  className?: string;
  width?: number;
  height?: number;
}) {
  const entered = useEntered();
  const present = values.filter((value): value is number => value !== null);
  if (present.length < 2) return null;
  const max = Math.max(...present);
  const min = Math.min(...present, 0);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const y = (value: number) => height - 3 - ((value - min) / span) * (height - 6);
  const segments: string[] = [];
  let current = "";
  values.forEach((value, index) => {
    if (value === null) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${(index * step).toFixed(1)} ${y(value).toFixed(1)}`;
  });
  if (current) segments.push(current);
  const lastIndex = values.length - 1 - [...values].reverse().findIndex((value) => value !== null);
  const lastValue = values[lastIndex] as number;
  return (
    <svg
      aria-hidden
      focusable="false"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("shrink-0 overflow-visible", className)}
    >
      <path
        d={segments.join(" ")}
        fill="none"
        stroke={SERIES_COLOR}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={entered ? 0 : 1}
        className="transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none"
      />
      <circle
        cx={lastIndex * step}
        cy={y(lastValue)}
        r={2.5}
        fill={SERIES_COLOR}
        stroke="#fff"
        strokeWidth={1.5}
        className="transition-opacity delay-500 duration-300 motion-reduce:transition-none"
        opacity={entered ? 1 : 0}
      />
    </svg>
  );
}
