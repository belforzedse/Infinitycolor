"use client";

import { useRef, type ReactNode } from "react";
import { numberText, ratioText } from "@/components/SuperAdmin/reports/shared/format";
import {
  buildComposition,
  type Composition,
  type CompositionDimension,
  type CompositionSegment,
} from "../audienceCharts";
import { useChartTip } from "@/components/SuperAdmin/reports/shared/ChartTooltip";
import { DeltaBadge } from "@/components/SuperAdmin/reports/shared/DeltaBadge";
import { useEntered } from "@/components/SuperAdmin/reports/shared/motion";
import { ShareBar } from "@/components/SuperAdmin/reports/shared/ShareBar";
import { SectionHeader } from "@/components/SuperAdmin/reports/shared/ui";

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
        <DeltaBadge className="mt-1" kind="points" neutral change={segment.changePp} suffix="سهم، نسبت به دوره قبل" />
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
  const { segments } = composition;
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
      <ShareBar
        segments={segments}
        label={`ترکیب بازدیدکنندگان بر اساس ${label}`}
        describe={segmentLabel}
        tipContent={(segment) => <TipContent segment={segment} />}
        onShow={onShow}
        onHide={onHide}
        entered={entered}
        order={order}
      />
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
