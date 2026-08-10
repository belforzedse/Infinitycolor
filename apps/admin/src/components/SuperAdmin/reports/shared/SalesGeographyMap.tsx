"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { MapPin } from "lucide-react";
import type { SalesBreakdownRow } from "@/services/super-admin/reports/salesBreakdown";
import { priceFormatter } from "@/utils/price";
import { faNum } from "@/utils/faNum";

// `react-iran-maps` uses framer-motion + DOM-measuring tooltips; never SSR.
const ChoroplethMap = dynamic(
  () => import("react-iran-maps").then((m) => m.ChoroplethMap),
  { ssr: false },
);

/** Sequential blue ramp (light → dark) for choropleth magnitude. */
export const GEOGRAPHY_MAP_COLORS = [
  "#cde2fb",
  "#86b6ef",
  "#3987e5",
  "#1c5cab",
  "#0d366b",
] as const;

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

/**
 * Province choropleth for the geography sales breakdown.
 *
 * The empty-key row is the unmapped/no-address bucket — excluded from the map
 * (nothing to color) but surfaced in the amber notice and kept in the table.
 */
export default function SalesGeographyMap({ rows }: SalesGeographyMapProps) {
  const mappedRows = useMemo(() => rows.filter((row) => row.key !== ""), [rows]);
  const unmappedRow = useMemo(() => rows.find((row) => row.key === ""), [rows]);

  const mapData = useMemo(
    () => mappedRows.map((row) => ({ name: row.label, value: row.netToman })),
    [mappedRows],
  );

  if (mapData.length === 0 && !(unmappedRow && unmappedRow.ordersCount > 0)) {
    return null;
  }

  return (
    <figure
      className="mb-6 overflow-hidden rounded-2xl border border-neutral-100 bg-neutral-50/60"
      aria-labelledby="sales-geography-map-title"
    >
      <figcaption className="flex items-start gap-3 border-b border-neutral-100 bg-white px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-infinity-primary/10 text-infinity-primary">
          <MapPin aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="sales-geography-map-title"
            className="text-sm font-semibold text-neutral-800"
          >
            نقشه فروش استان‌ها
          </h2>
          <p className="mt-1 text-xs leading-5 text-neutral-500">
            شدت رنگ، فروش خالص هر استان را نشان می‌دهد. جزئیات کامل در جدول زیر آمده است.
          </p>
        </div>
        <ol
          className="hidden shrink-0 items-center gap-1 sm:flex"
          aria-label="راهنمای شدت رنگ فروش"
        >
          <li className="text-[10px] text-neutral-400">کم</li>
          {GEOGRAPHY_MAP_COLORS.map((color) => (
            <li
              key={color}
              className="size-3 rounded-sm ring-1 ring-black/5"
              style={{ backgroundColor: color }}
              aria-hidden
            />
          ))}
          <li className="text-[10px] text-neutral-400">زیاد</li>
        </ol>
      </figcaption>

      <div className="space-y-4 p-4">
        {unmappedRow && unmappedRow.ordersCount > 0 && (
          <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {faNum(unmappedRow.ordersCount)} سفارش بدون آدرس تحویل قابل‌شناسایی (استان
            نامشخص) — در نقشه نمایش داده نمی‌شود، اما در جدول زیر و مجموع فروش لحاظ شده
            است.
          </div>
        )}

        {mapData.length > 0 && (
          <div
            className="mx-auto max-w-2xl rounded-2xl bg-white p-3 shadow-sm ring-1 ring-neutral-100 sm:p-5"
            data-testid="geography-map-frame"
          >
            <ChoroplethMap
              data={mapData}
              legend={{ mode: "quantitative", colors: [...GEOGRAPHY_MAP_COLORS] }}
              renderTooltipContent={(provinceData) => {
                if (!provinceData) return "";
                const name = escapeGeographyTooltipHtml(provinceData.name);
                const valueText =
                  typeof provinceData.value === "number"
                    ? priceFormatter(provinceData.value)
                    : "";
                return `<div style="text-align:right;direction:rtl;padding:8px;"><strong>${name}</strong><br/>خالص فروش: ${escapeGeographyTooltipHtml(valueText)} تومان</div>`;
              }}
            />
          </div>
        )}

        <p className="text-xs leading-5 text-neutral-500">
          نقشه جنبه نمایشی دارد؛ جدول زیر منبع اصلی و کامل داده است (شامل سفارش‌های بدون
          استان مشخص). داده در سطح استان است؛ تفکیک شهرستان در این نسخه پیاده‌سازی نشده
          است.
        </p>
      </div>
    </figure>
  );
}
