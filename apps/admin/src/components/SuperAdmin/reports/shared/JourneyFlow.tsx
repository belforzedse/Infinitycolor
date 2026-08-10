"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ResponsiveContainer, Sankey } from "./charts";
import { buildJourneyFlow, type JourneyNode, type JourneyRow } from "./journeyFlow";
import { faNum } from "@/utils/faNum";

/** Depth-column palette. Skips REPORT_CHART_COLORS[3] (#ef4444, red) —
 * that hue is reserved for negative-change semantics in MetricCard/KpiCard
 * and reusing it for a neutral column would misleadingly read as "bad". */
const DEPTH_COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#06b6d4"];
const TERMINAL_OVERFLOW_COLOR = "#94a3b8";
const LINK_COLOR = "#94a3b8";
const MOBILE_BREAKPOINT = 640;
const SANKEY_HEIGHT = 420;
const MAX_LABEL_CHARS = 14;

type JourneyFlowProps = {
  rows: unknown[];
  label: (raw: unknown) => string;
};

type FlowNodePayload = JourneyNode & { depth: number };

type SankeyNodeRenderProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  payload: FlowNodePayload;
};

type SankeyLinkRenderProps = {
  sourceX: number;
  targetX: number;
  sourceY: number;
  targetY: number;
  sourceControlX: number;
  targetControlX: number;
  linkWidth: number;
  index: number;
  payload: { value: number; source: FlowNodePayload; target: FlowNodePayload };
};

function asRows(value: unknown[]): JourneyRow[] {
  return value.filter(
    (row): row is JourneyRow => Boolean(row && typeof row === "object" && !Array.isArray(row)),
  );
}

function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function pathSteps(row: JourneyRow, label: (raw: unknown) => string): string[] {
  return [row.e1, row.e2, row.e3, row.e4]
    .filter((step) => step !== undefined && step !== null && String(step).trim() !== "")
    .map((step) => label(step));
}

function truncateLabel(value: string, max = MAX_LABEL_CHARS): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function CompactEmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-5 text-center">
      <p className="text-sm font-medium text-slate-600">هنوز داده‌ای ثبت نشده است</p>
      <p className="mt-1 text-xs text-slate-400">برای پرتکرارترین توالی اقدام‌ها</p>
    </div>
  );
}

function RankedPathsList({
  rows,
  label,
}: {
  rows: JourneyRow[];
  label: (raw: unknown) => string;
}) {
  const items = useMemo(
    () =>
      rows
        .map((row) => ({ steps: pathSteps(row, label), count: toCount(row.count) }))
        .filter((item) => item.steps.length > 0)
        .slice(0, 30),
    [rows, label],
  );
  if (!items.length) return <CompactEmptyState />;
  const max = Math.max(...items.map((item) => item.count), 1);
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white">
      <div className="divide-y divide-slate-100">
        {items.map((item, index) => (
          <div
            key={`${item.steps.join("|")}-${index}`}
            className="relative flex min-h-12 items-center justify-between gap-4 overflow-hidden px-4 py-2.5 text-xs"
          >
            <span
              aria-hidden
              className="absolute inset-y-1 right-1 rounded-md bg-infinity-primary/[0.055]"
              style={{ width: `${Math.max(0, Math.min(100, (item.count / max) * 100))}%` }}
            />
            <span className="relative min-w-0 truncate text-slate-600">
              {item.steps.join(" ← ")}
            </span>
            <span className="relative shrink-0 whitespace-nowrap font-semibold tabular-nums text-slate-800">
              {faNum(item.count)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Full accessible-name sentence for a node — shared by the hover/focus
 * detail panel, the SVG `<title>`, and `aria-label`. */
function nodeSentence(node: FlowNodePayload, value: number, totalPaths: number): string {
  const share = totalPaths > 0 ? Math.min(100, (value / totalPaths) * 100) : 0;
  const shareText = `${faNum(Math.round(share))}٪ از کل مسیرهای این نمودار`;
  if (node.isTerminal) {
    return `«${node.label}»: ${faNum(value)} کاربر در این مرحله ادامه نداده‌اند (${shareText}).`;
  }
  if (node.isOverflow) {
    return `«${node.label}»: مجموع ${faNum(value)} کاربر در مسیرهای کم‌تکرارتر (${shareText}).`;
  }
  return `«${node.label}»: ${faNum(value)} کاربر از این مرحله عبور کرده‌اند (${shareText}).`;
}

function linkSentence(payload: SankeyLinkRenderProps["payload"], totalPaths: number): string {
  const shareText =
    totalPaths > 0 ? `${faNum(Math.round((payload.value / totalPaths) * 100))}٪ از کل مسیرهای این نمودار` : "";
  const targetClause = payload.target.isTerminal
    ? "و در همین مرحله ادامه نداده‌اند"
    : `به «${payload.target.label}»`;
  return `از «${payload.source.label}» ${targetClause}: ${faNum(payload.value)} کاربر${shareText ? `؛ ${shareText}` : ""}.`;
}

export default function JourneyFlow({ rows, label }: JourneyFlowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !("ResizeObserver" in window)) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const journeyRows = useMemo(() => asRows(rows), [rows]);
  const flow = useMemo(
    () => buildJourneyFlow(journeyRows, { label }),
    [journeyRows, label],
  );

  const highlightId = activeId ?? selectedId;
  const connectedIds = useMemo(() => {
    if (!highlightId) return null;
    const ids = new Set<string>([highlightId]);
    for (const link of flow.links) {
      const sourceId = flow.nodes[link.source]?.id;
      const targetId = flow.nodes[link.target]?.id;
      const linkKey = `${sourceId}>>${targetId}`;
      if (sourceId === highlightId || targetId === highlightId || linkKey === highlightId) {
        if (sourceId) ids.add(sourceId);
        if (targetId) ids.add(targetId);
        ids.add(linkKey);
      }
    }
    return ids;
  }, [highlightId, flow]);

  const activeSentence = useMemo(() => {
    if (!activeId) return null;
    const nodeIndex = flow.nodes.findIndex((node) => node.id === activeId);
    if (nodeIndex >= 0) {
      const node = flow.nodes[nodeIndex] as FlowNodePayload;
      const value = flow.links.reduce((sum, link) => {
        if (link.target === nodeIndex) return sum + link.value;
        if (link.source === nodeIndex && flow.nodes[link.source]?.depth === 0) return sum + link.value;
        return sum;
      }, 0);
      return nodeSentence(node, value, flow.totalPaths);
    }
    const [sourceKey, targetKey] = activeId.split(">>");
    const sourceIndex = flow.nodes.findIndex((node) => node.id === sourceKey);
    const targetIndex = flow.nodes.findIndex((node) => node.id === targetKey);
    const link = flow.links.find((l) => l.source === sourceIndex && l.target === targetIndex);
    if (link && sourceIndex >= 0 && targetIndex >= 0) {
      return linkSentence(
        {
          value: link.value,
          source: flow.nodes[sourceIndex] as FlowNodePayload,
          target: flow.nodes[targetIndex] as FlowNodePayload,
        },
        flow.totalPaths,
      );
    }
    return null;
  }, [activeId, flow]);

  const description = flow.truncatedAtCap
    ? "این نمودار رایج‌ترین زنجیره‌های اقدام کاربران را نشان می‌دهد؛ حداکثر ۴ اقدام از هر بازدید ثبت شده است، بنابراین آنچه پس از اقدام چهارم رخ داده، در این داده دیده نمی‌شود."
    : "این نمودار رایج‌ترین زنجیره‌های اقدام کاربران را از نخستین قدم ثبت‌شده تا پایان مسیر نشان می‌دهد.";

  const sankeyData = useMemo(
    () => ({ nodes: flow.nodes, links: flow.links }),
    [flow],
  );

  const showSankey = width === 0 ? false : width >= MOBILE_BREAKPOINT;

  function renderNode(props: SankeyNodeRenderProps) {
    const node = props.payload;
    const id = node.id;
    const isDim = Boolean(connectedIds && !connectedIds.has(id));
    const fill = node.isTerminal || node.isOverflow
      ? TERMINAL_OVERFLOW_COLOR
      : DEPTH_COLORS[node.depth % DEPTH_COLORS.length];
    const nodeIndex = props.index;
    const value = flow.links.reduce((sum, link) => {
      if (link.target === nodeIndex) return sum + link.value;
      if (link.source === nodeIndex && node.depth === 0) return sum + link.value;
      return sum;
    }, 0);
    const sentence = nodeSentence(node, value, flow.totalPaths);
    return (
      <g
        tabIndex={0}
        role="button"
        aria-label={sentence}
        style={{ cursor: "pointer", outline: "none" }}
        onMouseEnter={() => setActiveId(id)}
        onMouseLeave={() => setActiveId(null)}
        onFocus={() => setActiveId(id)}
        onBlur={() => setActiveId(null)}
        onClick={() => setSelectedId((current) => (current === id ? null : id))}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setSelectedId((current) => (current === id ? null : id));
          }
        }}
      >
        <rect
          x={props.x}
          y={props.y}
          width={props.width}
          height={props.height}
          rx={2}
          fill={fill}
          opacity={isDim ? 0.25 : 1}
        />
        <title>{sentence}</title>
        <text
          x={props.x + props.width / 2}
          y={props.y - 6}
          textAnchor="middle"
          fontSize={10}
          fill="#334155"
          opacity={isDim ? 0.35 : 1}
        >
          {truncateLabel(node.label)}
        </text>
      </g>
    );
  }

  function renderLink(props: SankeyLinkRenderProps) {
    const sourceId = props.payload.source.id;
    const targetId = props.payload.target.id;
    const linkKey = `${sourceId}>>${targetId}`;
    const isDim = Boolean(connectedIds && !connectedIds.has(linkKey));
    const sentence = linkSentence(props.payload, flow.totalPaths);
    const path = `M${props.sourceX},${props.sourceY} C${props.sourceControlX},${props.sourceY} ${props.targetControlX},${props.targetY} ${props.targetX},${props.targetY}`;
    return (
      <path
        d={path}
        fill="none"
        stroke={LINK_COLOR}
        strokeOpacity={isDim ? 0.12 : 0.35}
        strokeWidth={Math.max(1, props.linkWidth)}
        tabIndex={0}
        role="button"
        aria-label={sentence}
        style={{ cursor: "pointer", outline: "none" }}
        onMouseEnter={() => setActiveId(linkKey)}
        onMouseLeave={() => setActiveId(null)}
        onFocus={() => setActiveId(linkKey)}
        onBlur={() => setActiveId(null)}
        onClick={() => setSelectedId((current) => (current === linkKey ? null : linkKey))}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setSelectedId((current) => (current === linkKey ? null : linkKey));
          }
        }}
      >
        <title>{sentence}</title>
      </path>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white">
      <div className="border-b border-slate-100 px-4 py-3 md:px-5">
        <h3 className="text-sm font-semibold text-slate-800">پرتکرارترین توالی اقدام‌های کاربران</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
      </div>
      <div className="p-4 md:p-5" ref={containerRef}>
        {flow.nodes.length === 0 ? (
          <CompactEmptyState />
        ) : !showSankey ? (
          <RankedPathsList rows={journeyRows} label={label} />
        ) : (
          <>
            <div dir="ltr">
              <ResponsiveContainer width="100%" height={SANKEY_HEIGHT}>
                <Sankey
                  data={sankeyData}
                  nodeWidth={14}
                  nodePadding={28}
                  margin={{ top: 24, right: 16, bottom: 16, left: 16 }}
                  node={renderNode as never}
                  link={renderLink as never}
                />
              </ResponsiveContainer>
            </div>
            <div
              className="mt-3 min-h-10 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2 text-xs text-slate-600"
              role="status"
              aria-live="polite"
            >
              {activeSentence ?? "برای دیدن جزئیات هر مرحله یا مسیر، روی آن نگه دارید یا با کیبورد به آن بروید."}
            </div>
            <details className="mt-3 rounded-xl border border-slate-100">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-slate-600">
                نمایش به‌صورت فهرست
              </summary>
              <div className="border-t border-slate-100 p-2">
                <RankedPathsList rows={journeyRows} label={label} />
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
