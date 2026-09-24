"use client";

import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/utils/tailwind";

/**
 * The one tooltip body every chart uses: what period (with its own date for a
 * comparison), the values with the series swatch, and a named reason wherever
 * a value is unknown or partial, never a silent zero.
 */
export function ChartTooltipCard({
  title,
  flag,
  rows,
  footer,
  className,
}: {
  title: ReactNode;
  /** «ناتمام», «بخشی از بازه»: a caveat on the whole period. */
  flag?: ReactNode;
  rows: ReadonlyArray<{
    key: string;
    label: ReactNode;
    value: ReactNode;
    color?: string;
    /** Dashed swatch for the comparison series. */
    muted?: boolean;
    /** Why the value is missing; shown instead of a number. */
    unknown?: ReactNode;
  }>;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div dir="rtl" className={cn("min-w-48 max-w-72 text-xs text-slate-700", className)}>
      <p className="text-slate-600">
        {title}
        {flag ? <span className="text-amber-800"> ({flag})</span> : null}
      </p>
      <dl className="mt-1.5 space-y-1">
        {rows.map((row) => (
          <div key={row.key} className="flex items-baseline justify-between gap-4">
            <dt className="flex min-w-0 items-center gap-1.5 text-slate-600">
              {row.color ? (
                <span
                  aria-hidden
                  className={cn("h-0.5 w-3 shrink-0 rounded", row.muted && "opacity-80")}
                  style={{ background: row.color }}
                />
              ) : null}
              <span className="min-w-0">{row.label}</span>
            </dt>
            <dd className={cn("tabular-nums", row.muted ? "text-slate-800" : "font-semibold text-slate-900")}>
              {row.unknown ? <span className="font-normal text-amber-800">{row.unknown}</span> : row.value}
            </dd>
          </div>
        ))}
      </dl>
      {footer ? <div className="mt-1.5">{footer}</div> : null}
    </div>
  );
}

/** Surface of a floating tooltip; shared by the HTML and recharts variants. */
export const TOOLTIP_SURFACE =
  "rounded-control border border-slate-200/80 bg-white/95 px-3 py-2 shadow-lg shadow-slate-900/5 backdrop-blur-sm";

/**
 * A readout that appears while a chart mark is hovered, focused or tapped,
 * anchored above the mark. It glides between marks, hides on Escape (WCAG
 * 1.4.13) and on a tap elsewhere, and only adds detail: every value is also
 * in the chart's legend or table view.
 */
export function useChartTip(containerRef: RefObject<HTMLDivElement | null>): {
  show: (mark: Element, content: ReactNode) => void;
  hide: () => void;
  tip: ReactNode;
} {
  const [state, setState] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const visible = state !== null;

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setState(null);
    };
    const onPointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setState(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [visible, containerRef]);

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
      className={cn(
        "pointer-events-none absolute z-20 min-w-44 max-w-64 text-xs text-slate-700",
        "transition-[left,top] duration-150 ease-out motion-reduce:transition-none",
        TOOLTIP_SURFACE,
      )}
      style={{ left: state.x, top: state.y, transform: "translate(-50%, calc(-100% - 8px))" }}
    >
      <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none">
        {state.content}
      </div>
    </div>
  ) : null;
  return { show, hide, tip };
}

/**
 * Escape for recharts tooltips. Recharts' keyboard layer moves the tooltip
 * with the arrow keys but has no way to close it; this forces it hidden
 * until the pointer moves or an arrow key is pressed again.
 */
export function useTooltipEscape(): {
  active: false | undefined;
  handlers: {
    onKeyDown: (event: ReactKeyboardEvent) => void;
    onPointerMove: () => void;
  };
} {
  const [dismissed, setDismissed] = useState(false);
  return {
    active: dismissed ? false : undefined,
    handlers: {
      onKeyDown: (event) => {
        if (event.key === "Escape") setDismissed(true);
        else if (event.key.startsWith("Arrow")) setDismissed(false);
      },
      onPointerMove: () => {
        if (dismissed) setDismissed(false);
      },
    },
  };
}
