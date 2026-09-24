"use client";

import { useId, useState, type ReactNode } from "react";
import { Clock, Info } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { CARD, FOCUS_RING, SkeletonBlock } from "@/components/admin";
import { Sparkline } from "./Sparkline";
import { ENTER, SWAP, useCountUp } from "./motion";

/**
 * One headline figure: label, value, change against the previous period,
 * and optionally a sparkline from data the page already loaded. The value
 * counts up when it arrives or changes; screen readers get the final value
 * only. A definition sits behind an ⓘ disclosure instead of a hover-only
 * `title`, and an open period (the range ends today) is marked as such.
 */
export default function KpiCard({
  title,
  amount,
  format,
  value,
  delta,
  previous,
  context,
  spark,
  info,
  estimate,
  incomplete,
  loading,
  surface = "card",
  order = 0,
  testId,
  className,
}: {
  title: string;
  /** A number to count up to; `format` turns it into text. Null is shown as «—». */
  amount?: number | null;
  format?: (value: number) => string;
  /** A ready-made value when the figure is not a plain number. */
  value?: ReactNode;
  /** Usually a `DeltaBadge`. */
  delta?: ReactNode;
  /** The previous period's value, already formatted. */
  previous?: ReactNode;
  context?: ReactNode;
  spark?: ReadonlyArray<number | null> | null;
  /** What the figure counts, revealed on demand. */
  info?: ReactNode;
  /** The value is apportioned rather than measured. */
  estimate?: boolean;
  /** The period is still open (it ends today), so the figure will still grow. */
  incomplete?: boolean;
  loading?: boolean;
  /** `plain` sits inside a strip that draws its own surface. */
  surface?: "card" | "plain";
  /** Position in its grid, for a staggered entrance. */
  order?: number;
  testId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const infoId = useId();
  const shown = useCountUp(amount ?? null);
  const settled = amount === undefined || shown === amount;
  const text = (number: number | null | undefined) =>
    number === null || number === undefined ? "—" : format ? format(number) : String(number);

  return (
    <div
      data-testid={testId}
      className={cn(
        "flex min-w-0 flex-col gap-1.5",
        surface === "card" ? cn(CARD, "p-4 md:p-5") : "bg-white p-4 md:px-5",
        ENTER,
        className,
      )}
      style={{ animationDelay: `${order * 40}ms` }}
      dir="rtl"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <h3
          className={cn(
            "min-w-0 break-words font-medium text-slate-700",
            // The strip is denser than a card.
            surface === "plain" ? "text-xs" : "text-sm",
          )}
        >
          {title}
        </h3>
        {estimate ? (
          <span className="shrink-0 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
            تخمینی
          </span>
        ) : null}
        {info || estimate ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={infoId}
            aria-label={`توضیح ${title}`}
            onClick={() => setOpen((current) => !current)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
            className={cn(
              "grid size-5 shrink-0 place-items-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600",
              open && "bg-slate-100 text-slate-700",
              FOCUS_RING,
            )}
          >
            <Info aria-hidden className="size-3.5" />
          </button>
        ) : null}
      </div>
      {open ? (
        <p id={infoId} className={cn("text-[11px] leading-5 text-slate-600", SWAP)}>
          {info}
          {estimate ? <> این مقدار تخمینی است: در سطح قلم تسهیم شده است.</> : null}
        </p>
      ) : null}
      {loading ? (
        <div aria-hidden className="space-y-2">
          <SkeletonBlock className="h-7 w-28" />
          <SkeletonBlock className="h-3 w-36" />
        </div>
      ) : (
        <>
          <p className="whitespace-nowrap text-xl font-semibold tabular-nums text-slate-900 md:text-2xl">
            {value !== undefined ? (
              value
            ) : settled ? (
              text(amount)
            ) : (
              <>
                <span aria-hidden>
                  {text(shown === null || !Number.isInteger(amount) ? shown : Math.round(shown))}
                </span>
                <span className="sr-only">{text(amount)}</span>
              </>
            )}
          </p>
          {delta || previous ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs animate-in fade-in-0 duration-500 fill-mode-backwards motion-reduce:animate-none [animation-delay:400ms]">
              {delta}
              {previous ? <span className="text-slate-500">دوره قبل: {previous}</span> : null}
            </div>
          ) : null}
          {context ? <p className="text-[11px] leading-4 text-slate-600">{context}</p> : null}
          {incomplete ? (
            <p className="flex items-center gap-1 text-[11px] text-slate-500">
              <Clock aria-hidden className="size-3 shrink-0" />
              امروز هنوز تمام نشده است
            </p>
          ) : null}
          {spark ? <Sparkline values={spark} width={120} height={24} className="mt-auto pt-1" /> : null}
        </>
      )}
    </div>
  );
}
