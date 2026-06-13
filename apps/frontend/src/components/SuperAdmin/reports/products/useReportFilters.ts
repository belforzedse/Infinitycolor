"use client";

import { useMemo } from "react";
import { parseAsString, useQueryState, useQueryStates } from "nuqs";
import type { ProductReportFilters } from "@/services/super-admin/reports/products";

const DAY_MS = 86_400_000;

function toDateOnly(d: Date): string {
  // yyyy-mm-dd in the local calendar (kept simple; backend bucketing handles tz).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DEFAULT_START = toDateOnly(new Date(Date.now() - 30 * DAY_MS));
const DEFAULT_END = toDateOnly(new Date());

const reportQueryParsers = {
  start: parseAsString.withDefault(DEFAULT_START),
  end: parseAsString.withDefault(DEFAULT_END),
  q: parseAsString.withDefault(""),
  cat: parseAsString.withDefault(""),
  ptype: parseAsString.withDefault(""),
  stock: parseAsString.withDefault(""),
  page: parseAsString.withDefault("1"),
} as const;

const reportQueryOptions = {
  history: "replace" as const,
} as const;

export type ReportTab = "overview" | "trends" | "performance" | "inventory" | "payments";

/** Full return shape of {@link useReportFilters}, passed down to FilterBar/tabs as props. */
export type ReportFilters = ReturnType<typeof useReportFilters>;

/**
 * Centralizes the report workspace URL state (shareable, back/forward safe).
 * Every tab and the filter bar read the same nuqs keys, so the URL is the single
 * source of truth for the selected period and filters.
 */
export function useReportFilters() {
  const [tab, setTab] = useQueryState("tab", { defaultValue: "overview" });
  const [{ start, end, q, cat, ptype, stock }, setQuery] = useQueryStates(
    reportQueryParsers,
    reportQueryOptions,
  );

  const filters: ProductReportFilters = useMemo(
    () => ({
      start,
      end,
      q: q || undefined,
      categoryId: cat ? Number(cat) : "",
      productType: (ptype as ProductReportFilters["productType"]) || "",
      stockStatus: (stock as ProductReportFilters["stockStatus"]) || "",
    }),
    [start, end, q, cat, ptype, stock],
  );

  return {
    start,
    end,
    tab: (tab as ReportTab) || "overview",
    q,
    cat,
    ptype,
    stock,
    filters,
    setStart: (v: string) => {
      setQuery({ start: v, page: "1" });
    },
    setEnd: (v: string) => {
      setQuery({ end: v, page: "1" });
    },
    setRange: (v: { start: string; end: string }) => {
      setQuery({ start: v.start, end: v.end, page: "1" });
    },
    setTab: (v: ReportTab) => setTab(v),
    setQ: (v: string) => {
      setQuery({ q: v || null, page: "1" });
    },
    setCat: (v: string) => {
      setQuery({ cat: v || null, page: "1" });
    },
    setPtype: (v: string) => {
      setQuery({ ptype: v || null, page: "1" });
    },
    setStock: (v: string) => {
      setQuery({ stock: v || null, page: "1" });
    },
  };
}
