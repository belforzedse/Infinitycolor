"use client";

import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/utils/tailwind";
import { FOCUS_RING } from "@/components/admin";
import { ratioText } from "./format";
import { MARK_SHEEN } from "./chartTheme";
import { useChartTip } from "./ChartTooltip";
import { useEntered } from "./motion";
import type { ShareSegment } from "./shares";
import { rovingKey } from "./ui";

/**
 * One slim 100% bar with its legend. Segments are separated by gaps (colour is
 * never the only cue), reveal from the start edge, morph when the data
 * changes, and dim the others while one is hovered or focused. Details live in
 * the tooltip, which the parent owns so several bars can share one.
 */
export function ShareBar<S extends ShareSegment>({
  segments,
  label,
  describe,
  tipContent,
  onShow,
  onHide,
  entered,
  order = 0,
}: {
  segments: S[];
  /** Names the group for assistive technology: «سهم درگاه‌ها از دریافتی». */
  label: string;
  /** The accessible name of one segment: label, share and value. */
  describe: (segment: S) => string;
  tipContent: (segment: S) => ReactNode;
  onShow: (mark: Element, content: ReactNode) => void;
  onHide: () => void;
  entered: boolean;
  /** Staggers the reveal of stacked bars. */
  order?: number;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  const activate = (index: number | null, mark?: Element | null) => {
    setActive(index === null ? null : segments[index].key);
    if (index === null || !mark) onHide();
    else onShow(mark, tipContent(segments[index]));
  };

  return (
    <div className="min-w-0">
      <div
        role="group"
        aria-label={label}
        className="flex w-full gap-0.5 transition-[clip-path] duration-700 ease-out motion-reduce:transition-none"
        style={{
          clipPath: entered ? "inset(0 0 0 0)" : "inset(0 0 0 100%)",
          transitionDelay: `${order * 90}ms`,
        }}
        onPointerLeave={() => activate(null)}
      >
        {segments.map((segment, index) => (
          <div
            key={segment.key}
            ref={(node) => {
              refs.current[index] = node;
            }}
            role="img"
            aria-label={describe(segment)}
            tabIndex={index === focusIndex ? 0 : -1}
            onPointerEnter={(event) => activate(index, event.currentTarget)}
            onFocus={(event) => {
              setFocusIndex(index);
              activate(index, event.currentTarget);
            }}
            onBlur={() => activate(null)}
            onKeyDown={(event) => {
              const next = rovingKey(event.key, index, segments.length);
              if (next === null) return;
              event.preventDefault();
              refs.current[next]?.focus();
            }}
            // The hit area is taller than the slim painted bar.
            className={cn(
              "flex h-6 min-w-[3px] cursor-default items-center rounded-[4px] transition-[flex-grow,opacity] duration-500 ease-out motion-reduce:transition-none",
              "first:[&>span]:rounded-r-full last:[&>span]:rounded-l-full",
              active !== null && active !== segment.key && "opacity-40",
              FOCUS_RING,
            )}
            style={{ flexGrow: segment.share, flexBasis: 0 }}
          >
            <span
              aria-hidden
              className="block h-4 w-full transition-[height] duration-200 ease-out"
              style={{ background: `${MARK_SHEEN}, ${segment.color}` }}
            />
          </div>
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
        {segments.map((segment, index) => (
          <li
            key={segment.key}
            className={cn(
              "flex items-center gap-1.5 transition-opacity",
              active !== null && active !== segment.key && "opacity-50",
            )}
            onPointerEnter={() => activate(index, refs.current[index])}
            onPointerLeave={() => activate(null)}
          >
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: segment.color }} />
            <span>{segment.label}</span>
            <span className="tabular-nums text-slate-500">{ratioText(segment.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A standalone share bar with its own tooltip: for a page section that shows
 * one part-to-whole split above its table.
 */
export function ShareSummary<S extends ShareSegment>({
  segments,
  label,
  describe,
  tipContent,
  note,
  className,
}: {
  segments: S[];
  label: string;
  describe: (segment: S) => string;
  tipContent: (segment: S) => ReactNode;
  note?: ReactNode;
  className?: string;
}) {
  const entered = useEntered();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tip = useChartTip(containerRef);
  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <ShareBar
        segments={segments}
        label={label}
        describe={describe}
        tipContent={tipContent}
        onShow={tip.show}
        onHide={tip.hide}
        entered={entered}
      />
      {note ? <p className="mt-1.5 text-[11px] text-slate-500">{note}</p> : null}
      {tip.tip}
    </div>
  );
}

/** The usual tooltip body for a share segment: name, share, value, and a folded tail's members. */
export function ShareTip({
  segment,
  valueText,
  extra,
}: {
  segment: ShareSegment;
  valueText: string;
  extra?: ReactNode;
}) {
  return (
    <>
      <p className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5 text-slate-600">
          <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: segment.color }} />
          {segment.label}
        </span>
        <strong className="text-sm tabular-nums text-slate-900">{ratioText(segment.share)}</strong>
      </p>
      <p className="mt-1 tabular-nums text-slate-600">{valueText}</p>
      {extra}
      {segment.members?.length ? (
        <p className="mt-1 text-slate-500">
          {segment.members
            .slice(0, 4)
            .map((member) => `${member.label} ${ratioText(member.share)}`)
            .join("، ")}
          {segment.members.length > 4 ? "، …" : ""}
        </p>
      ) : null}
    </>
  );
}
