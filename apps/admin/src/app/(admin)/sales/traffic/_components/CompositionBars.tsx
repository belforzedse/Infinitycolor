"use client";

import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/utils/tailwind";
import { FOCUS_RING } from "@/components/admin";
import { numberText, ratioText } from "../format";
import {
  MARK_SHEEN,
  buildComposition,
  type Composition,
  type CompositionDimension,
  type CompositionSegment,
} from "../audienceCharts";
import { Delta, SectionHeader, rovingKey, useChartTip, useEntered } from "./ui";

const DIMENSIONS: ReadonlyArray<{ id: CompositionDimension; label: string }> = [
  { id: "device", label: "دستگاه" },
  { id: "os", label: "سیستم‌عامل" },
  { id: "browser", label: "مرورگر" },
];

function segmentLabel(segment: CompositionSegment) {
  return `${segment.label}: ${ratioText(segment.share)}، ${numberText(segment.visitors)} بازدیدکننده`;
}

function TipContent({ segment }: { segment: CompositionSegment }) {
  return (
    <>
      <p className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5 text-slate-600">
          <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: segment.color }} />
          {segment.label}
        </span>
        <strong className="text-sm text-slate-900">{ratioText(segment.share)}</strong>
      </p>
      <p className="mt-1 text-slate-600">{numberText(segment.visitors)} بازدیدکننده</p>
      {segment.bounceRate !== null || segment.pagesPerVisit !== null ? (
        <p className="mt-0.5 text-slate-600">
          نرخ پرش {ratioText(segment.bounceRate)} · {numberText(segment.pagesPerVisit, 1)} صفحه در هر بازدید
        </p>
      ) : null}
      {segment.changePp !== null ? (
        <Delta className="mt-1" kind="points" neutral change={segment.changePp} suffix="سهم، نسبت به دوره قبل" />
      ) : null}
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

function CompositionRow({
  label,
  composition,
  order,
  entered,
  onShow,
  onHide,
}: {
  label: string;
  composition: Composition;
  order: number;
  entered: boolean;
  onShow: (mark: Element, content: ReactNode) => void;
  onHide: () => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  const { segments } = composition;
  const activate = (index: number | null, mark?: Element | null) => {
    setActive(index === null ? null : segments[index].key);
    if (index === null || !mark) onHide();
    else onShow(mark, <TipContent segment={segments[index]} />);
  };
  const lead = segments[0];

  return (
    <div className="grid gap-x-6 gap-y-2 md:grid-cols-[132px_minmax(0,1fr)] md:items-start">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900">{label}</p>
        {lead?.kind === "named" ? (
          <p className="truncate text-[11px] text-slate-500">
            بیشتر {lead.label}
          </p>
        ) : null}
      </div>
      <div className="min-w-0">
        <div
          role="group"
          aria-label={`ترکیب بازدیدکنندگان بر اساس ${label}`}
          className={cn(
            "flex w-full gap-0.5 transition-[clip-path] duration-700 ease-out motion-reduce:transition-none",
          )}
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
              aria-label={segmentLabel(segment)}
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
                className="block h-4 w-full"
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
    </div>
  );
}

/**
 * Who uses what, at a glance: one 100% bar per technical dimension. Details
 * (visitors, bounce, change against the previous period) appear on hover or
 * keyboard focus; the tables below hold every value.
 */
export default function CompositionBars({
  sections,
  previousSections,
}: {
  sections: Record<string, unknown>;
  previousSections?: Record<string, unknown> | null;
}) {
  const entered = useEntered();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tip = useChartTip(containerRef);
  const rows = DIMENSIONS.map((dimension) => ({
    ...dimension,
    composition: buildComposition(
      dimension.id,
      sections[dimension.id],
      previousSections ? previousSections[dimension.id] : undefined,
    ),
  })).filter(
    (row): row is typeof row & { composition: Composition } => row.composition !== null,
  );
  if (!rows.length) return null;
  return (
    <section aria-labelledby="composition-title" className="space-y-4">
      <SectionHeader
        id="composition-title"
        title="ترکیب مخاطبان"
        description="سهم بازدیدکنندگان از هر دستگاه، سیستم‌عامل و مرورگر."
      />
      <div ref={containerRef} className="relative space-y-5">
        {rows.map((row, index) => (
          <CompositionRow
            key={row.id}
            label={row.label}
            composition={row.composition}
            order={index}
            entered={entered}
            onShow={tip.show}
            onHide={tip.hide}
          />
        ))}
        {tip.tip}
      </div>
    </section>
  );
}
