"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { signedPercentText, signedPointsText } from "./format";
import { BAD_TEXT, GOOD_TEXT, NEUTRAL_TEXT } from "./chartTheme";

/**
 * A period-over-period change. Direction is carried by an arrow, a sign and
 * (for screen readers) words, so colour only reinforces it. A change between
 * two rates is given in percentage points (`kind="points"`), everything else
 * relative. Without a base it says so instead of printing a fake 0%.
 */
export function DeltaBadge({
  change,
  kind = "relative",
  lowerIsBetter = false,
  neutral = false,
  className,
  suffix,
  noComparisonText = "بدون مبنای مقایسه",
}: {
  change: number | null;
  kind?: "relative" | "points";
  lowerIsBetter?: boolean;
  /** A shift that is neither good nor bad (a share of the mix): no colour. */
  neutral?: boolean;
  className?: string;
  suffix?: ReactNode;
  /** Why there is nothing to compare with, e.g. a previous period before the data floor. */
  noComparisonText?: ReactNode;
}) {
  if (change === null || !Number.isFinite(change)) {
    return <span className={cn("text-xs text-slate-500", className)}>{noComparisonText}</span>;
  }
  const flat = Math.abs(change) < (kind === "points" ? 0.05 : 0.5);
  const up = change > 0;
  const good = flat || neutral ? null : lowerIsBetter ? !up : up;
  const Icon = flat ? Minus : up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        good === null ? NEUTRAL_TEXT : good ? GOOD_TEXT : BAD_TEXT,
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {flat ? (
        <span>بدون تغییر</span>
      ) : (
        <>
          <span className="sr-only">{up ? "افزایش" : "کاهش"}</span>
          <span dir="ltr" className="tabular-nums">
            {kind === "points" ? signedPointsText(change) : signedPercentText(change)}
          </span>
        </>
      )}
      {suffix ? <span className="font-normal text-slate-500">{suffix}</span> : null}
    </span>
  );
}
