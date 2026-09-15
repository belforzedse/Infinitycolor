"use client";

import type { ReactNode } from "react";
import { cn } from "@/utils/tailwind";
import { formatMetric, type MetricFormat } from "@/components/admin/MetricCard";

/**
 * Renders a money identity with this range's real numbers in it, e.g.
 * «مجموع دریافتی درگاه‌ها − هزینه ارسال = فروش کالا».
 *
 * Reports here carry money definitions that do not match term for term — cash
 * collected at the gateway (merchandise + shipping, after discount, counted on
 * the payment date), «فروش ناخالص» (merchandise + shipping, before discount, on
 * the order date) and «فروش خالص» (merchandise only) — and every figure is
 * correct under its own definition. Two pages showing two totals with no
 * arithmetic between them reads as a bug, so each page states the term that
 * accounts for its own gap.
 *
 * Only ever build a formula whose terms come from ONE endpoint/order set. The
 * cross-page relationship is approximate (different clocks) and belongs in
 * `note`, never in the equation.
 */
export type FormulaTerm = {
  label: string;
  value: number;
  format?: MetricFormat;
  /** Drawn before the term; omit on the first one. */
  op?: "+" | "−";
};

export type FormulaResult = {
  label: string;
  value: number;
  format?: MetricFormat;
  /** "≈" when the two sides are related but not identical. Defaults to "=". */
  relation?: "=" | "≈";
};

function Chip({
  label,
  value,
  format = "toman",
  emphasis,
}: {
  label: string;
  value: number;
  format?: MetricFormat;
  emphasis?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-lg border px-2.5 py-1.5",
        emphasis
          ? "border-infinity-primary/30 bg-infinity-primary/5"
          : "border-neutral-100 bg-neutral-50/80",
      )}
    >
      <span className="text-[11px] leading-tight text-neutral-500">{label}</span>
      <span
        className={cn(
          "text-sm font-semibold leading-tight tabular-nums",
          emphasis ? "text-infinity-primary" : "text-neutral-800",
        )}
      >
        {formatMetric(value, format)}
      </span>
    </span>
  );
}

/** Operator glyph. Paired inside the same flex item as its term so a wrap never orphans it. */
function Op({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 px-1 text-base font-medium text-neutral-400">
      {children}
    </span>
  );
}

export default function MetricFormula({
  terms,
  result,
  note,
  className,
}: {
  terms: FormulaTerm[];
  result: FormulaResult;
  /** The caveat that keeps the identity honest — clock differences, estimates. */
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-neutral-100 bg-white px-3 py-3 md:px-4",
        className,
      )}
      dir="rtl"
    >
      <div className="flex flex-wrap items-stretch gap-y-2">
        {terms.map((term, i) => (
          <span key={`${term.label}-${i}`} className="flex items-stretch">
            {i > 0 && <Op>{term.op ?? "+"}</Op>}
            <Chip label={term.label} value={term.value} format={term.format} />
          </span>
        ))}
        {/* The relation stays welded to the result so it never ends a line alone. */}
        <span className="flex items-stretch">
          <Op>{result.relation ?? "="}</Op>
          <Chip
            label={result.label}
            value={result.value}
            format={result.format}
            emphasis
          />
        </span>
      </div>
      {note && (
        <p className="mt-2.5 text-[11px] leading-5 text-neutral-500">{note}</p>
      )}
    </div>
  );
}
