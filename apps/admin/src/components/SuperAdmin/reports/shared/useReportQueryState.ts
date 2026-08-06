"use client";

import { useMemo } from "react";
import { parseAsString, useQueryState, useQueryStates } from "nuqs";
import { toDateOnly, defaultReportStart, defaultReportEnd } from "./reportDates";

export { toDateOnly, parseDateOnly, defaultReportStart, defaultReportEnd } from "./reportDates";

export interface UseReportQueryStateOptions<K extends string> {
  /** Extra report-specific filter keys (e.g. ["cat","ptype","stock"]); each defaults to "". */
  extraKeys?: readonly K[];
  defaultStart?: string;
  defaultEnd?: string;
  /** Pass false to omit the "tab" query key entirely (single-view report pages). */
  tab?: false | { defaultValue: string };
}

/**
 * Shared report-workspace URL state: every report page reads/writes the SAME nuqs
 * keys for the period (start/end), pagination (page) and, optionally, a tab
 * selector — plus whatever extra filter keys that report declares. Extracted from
 * `reports/products/useReportFilters.ts` (Phase 3) so new report pages (sales
 * breakdown, customers, geography, ...) don't re-derive this.
 */
export function useReportQueryState<K extends string = never>(
  options: UseReportQueryStateOptions<K> = {},
) {
  const defaultStart = options.defaultStart ?? defaultReportStart();
  const defaultEnd = options.defaultEnd ?? defaultReportEnd();
  const extraKeys = options.extraKeys ?? ([] as readonly K[]);
  const extraKeysKey = extraKeys.join(",");

  const parsers = useMemo(() => {
    const base: Record<string, ReturnType<typeof parseAsString.withDefault>> = {
      start: parseAsString.withDefault(defaultStart),
      end: parseAsString.withDefault(defaultEnd),
      page: parseAsString.withDefault("1"),
    };
    for (const key of extraKeys) base[key] = parseAsString.withDefault("");
    return base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultStart, defaultEnd, extraKeysKey]);

  const [values, setValues] = useQueryStates(parsers, { history: "replace" as const });
  const [tab, setTab] = useQueryState(
    "tab",
    options.tab === false ? { defaultValue: "" } : { defaultValue: options.tab?.defaultValue ?? "" },
  );

  /** Sets one extra filter key, resetting pagination to page 1 (empty string clears it from the URL). */
  const setFilter = (key: K, value: string) => {
    setValues({ [key]: value || null, page: "1" } as Partial<Record<string, string | null>>);
  };

  const setRange = (range: { start: string; end: string }) => {
    setValues({ start: range.start, end: range.end, page: "1" });
  };

  const setPage = (page: number | string) => {
    setValues({ page: String(page) });
  };

  return {
    start: values.start,
    end: values.end,
    page: values.page,
    values: values as Record<K, string> & { start: string; end: string; page: string },
    tab,
    setTab: options.tab === false ? undefined : setTab,
    setRange,
    setFilter,
    setPage,
    setValues,
  };
}
