"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Info, Minus } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { FOCUS_RING } from "@/components/admin";
import { signedPercentText, signedPointsText } from "../format";

/** Brand series and the de-emphasised comparison series (validated pair). */
export const SERIES_COLOR = "#3d4c6e";
export const COMPARISON_COLOR = "#7c8798";

/**
 * A period-over-period change. Direction is carried by an arrow and a sign as
 * well as colour, and screen readers get the words.
 */
export function Delta({
  change,
  kind = "relative",
  lowerIsBetter = false,
  neutral = false,
  className,
  suffix,
}: {
  change: number | null;
  kind?: "relative" | "points";
  lowerIsBetter?: boolean;
  /** A shift that is neither good nor bad (a share of the mix): no colour. */
  neutral?: boolean;
  className?: string;
  suffix?: ReactNode;
}) {
  if (change === null || !Number.isFinite(change)) {
    return (
      <span className={cn("text-xs text-slate-500", className)}>
        بدون مبنای مقایسه
      </span>
    );
  }
  const flat = Math.abs(change) < (kind === "points" ? 0.05 : 0.5);
  const up = change > 0;
  const good = flat || neutral ? null : lowerIsBetter ? !up : up;
  const Icon = flat ? Minus : up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        good === null ? "text-slate-600" : good ? "text-emerald-700" : "text-rose-700",
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

/**
 * A small exclusive choice (metric, perspective, scope). A radiogroup: Tab
 * enters, arrow keys move between options.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  size = "md",
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string; disabled?: boolean; hint?: string }>;
  onChange: (value: T) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.filter((option) => !option.disabled);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const position = enabled.findIndex((option) => option.id === options[index].id);
    // In RTL the visual "next" is to the left.
    const step = event.key === "ArrowLeft" || event.key === "ArrowDown" ? 1 : -1;
    const nextPosition =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? enabled.length - 1
          : (position + step + enabled.length) % enabled.length;
    const next = enabled[nextPosition];
    onChange(next.id);
    refs.current[options.indexOf(next)]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-control border border-slate-200 bg-slate-50 p-0.5",
        className,
      )}
    >
      {options.map((option, index) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            title={option.hint}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "whitespace-nowrap rounded-[calc(var(--radius-control)-2px)] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-xs md:text-sm",
              selected
                ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
                : "text-slate-600 hover:text-slate-900",
              FOCUS_RING,
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Heading row of a workspace section: title and definition on one side, controls on the other. */
export function SectionHeader({
  title,
  description,
  actions,
  className,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h3 id={id} className="text-base font-semibold text-slate-900">
          {title}
        </h3>
        {description ? (
          <p className="max-w-3xl text-xs leading-5 text-slate-600">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
  className,
  title,
}: {
  tone?: "info" | "warning" | "error";
  children?: ReactNode;
  className?: string;
  title?: ReactNode;
}) {
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-control border px-3 py-2 text-xs leading-5",
        tone === "info" && "border-slate-200 bg-slate-50 text-slate-700",
        tone === "warning" && "border-amber-200 bg-amber-50 text-amber-900",
        tone === "error" && "border-rose-200 bg-rose-50 text-rose-900",
        className,
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        {title ? <p className="font-medium">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}

/** Where a number comes from; data authority is part of the label, not a tooltip. */
export function SourceLabel({ source }: { source: "umami" | "commerce" }) {
  return (
    <span className="text-[11px] text-slate-500">
      {source === "commerce" ? "از سفارش‌های فروشگاه" : "از آمار بازدید (Umami)"}
    </span>
  );
}

/**
 * A 12–60 point trend line drawn as plain SVG (no chart runtime). Decorative:
 * the same numbers are in the trend chart's table view.
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
  const present = values.filter((value): value is number => value !== null);
  if (present.length < 2) return null;
  const max = Math.max(...present);
  const min = Math.min(...present, 0);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const segments: string[] = [];
  let current = "";
  values.forEach((value, index) => {
    if (value === null) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    const x = (index * step).toFixed(1);
    const y = (height - 3 - ((value - min) / span) * (height - 6)).toFixed(1);
    current += `${current ? "L" : "M"}${x} ${y}`;
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
      />
      <circle
        cx={lastIndex * step}
        cy={height - 3 - ((lastValue - min) / span) * (height - 6)}
        r={2.5}
        fill={SERIES_COLOR}
        stroke="#fff"
        strokeWidth={1.5}
      />
    </svg>
  );
}

/** A compact «show exact values» toggle for charts. */
export function TableToggle({
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
        "rounded-control border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-slate-300",
        FOCUS_RING,
      )}
    >
      {showing ? "نمایش نمودار" : "نمایش جدول"}
    </button>
  );
}

/**
 * False on the first paint, true one frame later: lets a chart transition in
 * from empty. Under reduced motion the `motion-reduce:` utilities skip the
 * transition, so the final state simply appears.
 */
export function useEntered() {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return entered;
}

/**
 * A readout that appears only while a chart mark is hovered or focused,
 * anchored above the mark. Every value it shows is also in the chart's legend
 * or table view; it adds detail, it never gates it.
 */
export function useChartTip(containerRef: RefObject<HTMLDivElement | null>): {
  show: (mark: Element, content: ReactNode) => void;
  hide: () => void;
  tip: ReactNode;
} {
  const [state, setState] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const show = (mark: Element, content: ReactNode) => {
    const container = containerRef.current;
    if (!container) return;
    const box = container.getBoundingClientRect();
    const rect = mark.getBoundingClientRect();
    const margin = Math.min(110, box.width / 2);
    const x = Math.min(box.width - margin, Math.max(margin, rect.left + rect.width / 2 - box.left));
    setState({ x, y: rect.top - box.top, content });
  };
  const hide = () => setState(null);
  const tip = state ? (
    <div
      role="tooltip"
      dir="rtl"
      className="pointer-events-none absolute z-20 min-w-44 max-w-64 rounded-control border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-md"
      style={{ left: state.x, top: state.y, transform: "translate(-50%, calc(-100% - 6px))" }}
    >
      {state.content}
    </div>
  ) : null;
  return { show, hide, tip };
}

/** Arrow/Home/End movement for a roving-tabindex group (RTL: left is next). */
export function rovingKey(key: string, index: number, count: number): number | null {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowLeft") return Math.min(count - 1, index + 1);
  if (key === "ArrowRight") return Math.max(0, index - 1);
  return null;
}
