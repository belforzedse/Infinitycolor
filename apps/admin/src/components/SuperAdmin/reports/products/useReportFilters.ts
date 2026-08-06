"use client";

import { useMemo } from "react";
import type { ProductReportFilters } from "@/services/super-admin/reports/products";
import { useReportQueryState } from "../shared/useReportQueryState";

export type ReportTab = "overview" | "trends" | "performance" | "inventory" | "payments";

/** Full return shape of {@link useReportFilters}, passed down to FilterBar/tabs as props. */
export type ReportFilters = ReturnType<typeof useReportFilters>;

const EXTRA_KEYS = ["q", "cat", "ptype", "stock"] as const;

/**
 * Centralizes the report workspace URL state (shareable, back/forward safe).
 * Every tab and the filter bar read the same nuqs keys, so the URL is the single
 * source of truth for the selected period and filters. Built on the shared
 * `useReportQueryState` primitive (Phase 3) — this file now only adds the
 * product-report-specific filter keys and the `ProductReportFilters` shape.
 */
export function useReportFilters() {
  const state = useReportQueryState<(typeof EXTRA_KEYS)[number]>({
    extraKeys: EXTRA_KEYS,
    tab: { defaultValue: "overview" },
  });
  const { start, end, values, setValues } = state;
  const { q, cat, ptype, stock } = values;

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
    tab: (state.tab as ReportTab) || "overview",
    q,
    cat,
    ptype,
    stock,
    filters,
    setStart: (v: string) => {
      setValues({ start: v, page: "1" });
    },
    setEnd: (v: string) => {
      setValues({ end: v, page: "1" });
    },
    setRange: state.setRange,
    setTab: (v: ReportTab) => state.setTab?.(v),
    setQ: (v: string) => state.setFilter("q", v),
    setCat: (v: string) => state.setFilter("cat", v),
    setPtype: (v: string) => state.setFilter("ptype", v),
    setStock: (v: string) => state.setFilter("stock", v),
  };
}
