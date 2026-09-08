"use client";

import { useEffect, useRef } from "react";
import { useQueryState } from "nuqs";

import {
  parseAdvancedFiltersParam,
  serializeAdvancedFiltersParam,
  type AdvancedFilterItem,
} from "@/components/SuperAdmin/Table/advancedFilters";

const LEGACY_FILTER_QUERY_KEY = "filter";

/**
 * Removes the retired URL-backed filter once, but only when the key is really
 * present. The parsed value cannot distinguish an absent key from an empty or
 * malformed legacy value, so the guard intentionally checks the URL itself.
 */
export function useLegacyFilterQueryCleanup() {
  const cleanupRequested = useRef(false);
  const [, setLegacyUrlFilters] = useQueryState<AdvancedFilterItem[]>(
    LEGACY_FILTER_QUERY_KEY,
    {
      defaultValue: [],
      parse: parseAdvancedFiltersParam,
      serialize: serializeAdvancedFiltersParam,
      history: "replace",
    },
  );

  useEffect(() => {
    if (cleanupRequested.current) return;
    if (
      !new URLSearchParams(window.location.search).has(LEGACY_FILTER_QUERY_KEY)
    )
      return;

    cleanupRequested.current = true;
    void setLegacyUrlFilters(null, { history: "replace" });
  }, [setLegacyUrlFilters]);
}
