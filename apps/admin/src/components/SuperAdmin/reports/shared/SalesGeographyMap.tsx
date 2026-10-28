"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { MapPin } from "lucide-react";
import type { SalesBreakdownRow } from "@/services/super-admin/reports/salesBreakdown";
import { priceFormatter } from "@/utils/price";
import { faNum } from "@/utils/faNum";
import { SEQUENTIAL_RAMP } from "./chartTheme";

// `react-iran-maps` uses framer-motion + DOM-measuring tooltips; never SSR.
const ChoroplethMap = dynamic(
  () => import("react-iran-maps").then((m) => m.ChoroplethMap),
  { ssr: false },
);

/**
 * Choropleth magnitude on the reports' one sequential ramp (navy, light →
 * dark), so a province map and an hour heatmap read the same way. The
 * near-white first step is skipped: it would vanish against the map's land.
 */
export const GEOGRAPHY_MAP_COLORS = SEQUENTIAL_RAMP.slice(2);

const MAP_ASPECT_RATIO = 1.23;
const MAP_MIN_HEIGHT = 560;
const MAP_FALLBACK_WIDTH = 1100;
// Below this frame width the min-height floor would force a box far taller
// than the aspect-locked map, leaving a large blank strip under it on phones.
const MAP_MIN_HEIGHT_BREAKPOINT = 640;

/** Escapes text interpolated into `renderTooltipContent`'s HTML-string return. */
export function escapeGeographyTooltipHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type SalesGeographyMapProps = {
  rows: SalesBreakdownRow[];
};

type MapSize = {
  width: number;
  height: number;
};

function useMapFrameSize(): {
  ref: React.RefObject<HTMLDivElement | null>;
  size: MapSize;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<MapSize>({
    width: MAP_FALLBACK_WIDTH,
    height: Math.round(MAP_FALLBACK_WIDTH / MAP_ASPECT_RATIO),
  });

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const update = (width: number) => {
      const nextWidth = Math.max(Math.floor(width), 320);
      const aspectHeight = Math.round(nextWidth / MAP_ASPECT_RATIO);
      const nextHeight =
        nextWidth >= MAP_MIN_HEIGHT_BREAKPOINT
          ? Math.max(aspectHeight, MAP_MIN_HEIGHT)
          : aspectHeight;
      setSize((prev) =>
        prev.width === nextWidth && prev.height === nextHeight
          ? prev
          : { width: nextWidth, height: nextHeight },
      );
    };

    update(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      update(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}

function toman(value: number): string {
  return `${priceFormatter(value)} تومان`;
}

/**
 * Province choropleth for the geography sales breakdown.
 *
 * The empty-key row is the unmapped/no-address bucket — excluded from the map
 * (nothing to color) but surfaced in the amber notice and kept in the table.
 */
export default function SalesGeographyMap({ rows }: SalesGeographyMapProps) {
  const { ref: mapFrameRef, size: mapSize } = useMapFrameSize();

  const mappedRows = useMemo(() => rows.filter((row) => row.key !== ""), [rows]);
  const unmappedRow = useMemo(() => rows.find((row) => row.key === ""), [rows]);

  const rowsByLabel = useMemo(() => {
    const map = new Map<string, SalesBreakdownRow>();
    for (const row of mappedRows) {
      map.set(row.label, row);
    }
    return map;
  }, [mappedRows]);

  const mapData = useMemo(
    () => mappedRows.map((row) => ({ name: row.label, value: row.netToman })),
    [mappedRows],
  );

  const totals = useMemo(() => {
    const netToman = mappedRows.reduce((sum, row) => sum + row.netToman, 0);
    const ordersCount = mappedRows.reduce((sum, row) => sum + row.ordersCount, 0);
    const top = mappedRows.reduce<SalesBreakdownRow | null>((best, row) => {
      if (!best || row.netToman > best.netToman) return row;
      return best;
    }, null);
    return { netToman, ordersCount, top, provinceCount: mappedRows.length };
  }, [mappedRows]);

  if (mapData.length === 0 && !(unmappedRow && unmappedRow.ordersCount > 0)) {
    return null;
  }

  return (
    <figure
      className="mb-6 overflow-hidden rounded-2xl border border-neutral-100 bg-gradient-to-b from-white to-neutral-50/80"
      aria-labelledby="sales-geography-map-title"
    >
      <figcaption className="flex flex-col gap-3 border-b border-neutral-100 bg-white/90 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-infinity-primary/10 text-infinity-primary">
            <MapPin aria-hidden className="size-5" />
          </span>
          <div className="min-w-0">
            <h2
              id="sales-geography-map-title"
              className="text-base font-semibold text-neutral-800"
            >
              نقشه فروش استان‌ها
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-neutral-500 sm:text-sm">
              شدت رنگ، فروش خالص هر استان را نشان می‌دهد. روی استان نگه دارید تا جزئیات
              سفارش و مبلغ را ببینید؛ جدول زیر منبع کامل داده است.
            </p>
          </div>
        </div>
        <ol
          className="flex shrink-0 items-center gap-1.5 self-start rounded-full bg-neutral-50 px-3 py-1.5 ring-1 ring-neutral-100"
          aria-label="راهنمای شدت رنگ فروش"
        >
          <li className="text-[11px] text-neutral-400">کم</li>
          {GEOGRAPHY_MAP_COLORS.map((color) => (
            <li
              key={color}
              className="size-3.5 rounded-sm ring-1 ring-black/5"
              style={{ backgroundColor: color }}
              aria-hidden
            />
          ))}
          <li className="text-[11px] text-neutral-400">زیاد</li>
        </ol>
      </figcaption>

      <div className="space-y-5 p-4 sm:p-5">
        {unmappedRow && unmappedRow.ordersCount > 0 && (
          <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {faNum(unmappedRow.ordersCount)} سفارش بدون آدرس تحویل قابل‌شناسایی (استان
            نامشخص) — در نقشه نمایش داده نمی‌شود، اما در جدول زیر و مجموع فروش لحاظ شده
            است.
          </div>
        )}

        {mapData.length > 0 ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-neutral-100 bg-white px-4 py-3">
                <p className="text-[11px] text-neutral-400">استان‌های دارای فروش</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-neutral-800">
                  {faNum(totals.provinceCount)}
                </p>
              </div>
              <div className="rounded-2xl border border-neutral-100 bg-white px-4 py-3">
                <p className="text-[11px] text-neutral-400">فروش خالص روی نقشه</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-neutral-800">
                  {toman(totals.netToman)}
                </p>
                <p className="mt-1 text-[11px] text-neutral-400">
                  {faNum(totals.ordersCount)} سفارش
                </p>
              </div>
              <div className="rounded-2xl border border-neutral-100 bg-white px-4 py-3">
                <p className="text-[11px] text-neutral-400">برترین استان</p>
                <p className="mt-1 truncate text-lg font-semibold text-neutral-800">
                  {totals.top?.label ?? "—"}
                </p>
                {totals.top ? (
                  <p className="mt-1 text-[11px] tabular-nums text-neutral-400">
                    {toman(totals.top.netToman)}
                  </p>
                ) : null}
              </div>
            </div>

            <div
              ref={mapFrameRef}
              className="w-full overflow-hidden rounded-2xl bg-white p-2 shadow-sm ring-1 ring-neutral-100 sm:p-4"
              style={{ minHeight: mapSize.height }}
              data-testid="geography-map-frame"
            >
              <div className="mx-auto w-full" style={{ minHeight: mapSize.height }}>
                <ChoroplethMap
                  data={mapData}
                  width={mapSize.width}
                  height={mapSize.height}
                  aspectRatio={String(MAP_ASPECT_RATIO)}
                  // The library's own legend renders in a fixed-width, forced-ltr row that
                  // overflows/garbles on narrow (mobile) screens; we show our own
                  // RTL-safe "کم/زیاد" legend above instead (see figcaption).
                  legend={{
                    mode: "quantitative",
                    colors: [...GEOGRAPHY_MAP_COLORS],
                    disable: true,
                  }}
                  renderTooltipContent={(provinceData) => {
                    if (!provinceData) return "";
                    const name = escapeGeographyTooltipHtml(provinceData.name);
                    const row = rowsByLabel.get(provinceData.name);
                    const netText =
                      typeof provinceData.value === "number"
                        ? priceFormatter(provinceData.value)
                        : "";
                    const orders =
                      row != null ? faNum(row.ordersCount) : "—";
                    const units = row != null ? faNum(row.units) : "—";
                    return `<div style="text-align:right;direction:rtl;padding:10px 12px;min-width:160px;line-height:1.6;">
                      <div style="font-weight:700;font-size:13px;margin-bottom:6px;">${name}</div>
                      <div style="font-size:12px;">خالص فروش: <strong>${escapeGeographyTooltipHtml(netText)}</strong> تومان</div>
                      <div style="font-size:12px;opacity:.85;">سفارش‌ها: ${escapeGeographyTooltipHtml(orders)}</div>
                      <div style="font-size:12px;opacity:.85;">تعداد کالا: ${escapeGeographyTooltipHtml(units)}</div>
                    </div>`;
                  }}
                />
              </div>
            </div>
          </>
        ) : null}

        <p className="text-xs leading-5 text-neutral-500">
          نقشه جنبه نمایشی دارد؛ جدول زیر منبع اصلی و کامل داده است (شامل سفارش‌های بدون
          استان مشخص). داده در سطح استان است؛ تفکیک شهرستان در این نسخه پیاده‌سازی نشده
          است.
        </p>
      </div>
    </figure>
  );
}
