"use client";

import { useCallback } from "react";
import { createParser, parseAsString, useQueryStates } from "nuqs";
import {
  parseAdvancedFiltersParam,
  serializeAdvancedFiltersParam,
  type AdvancedFilterItem,
} from "./advancedFilters";

/**
 * Advanced filters in the URL under `af`. `filter` is the retired key that
 * useLegacyFilterQueryCleanup strips on sight, so the filters live under their
 * own key.
 */
export const advancedFiltersParser = createParser<AdvancedFilterItem[]>({
  parse: (value) => {
    const parsed = parseAdvancedFiltersParam(value);
    return parsed.length ? parsed : null;
  },
  serialize: (value) => serializeAdvancedFiltersParam(value),
  eq: (a, b) => JSON.stringify(a) === JSON.stringify(b),
});

const PARSERS = {
  af: advancedFiltersParser.withDefault([]),
  page: parseAsString.withDefault("1"),
};

/**
 * A list page's advanced filters, kept in the URL so a reload, Back/Forward and
 * a shared link reproduce them. The setter writes the filters and page 1 in one
 * update, from the caller's event handler: a URL write from a mount effect
 * would race a `<Link>` navigation and cancel it.
 */
export function useAdvancedFiltersUrlState() {
  const [state, setState] = useQueryStates(PARSERS, { history: "push" });

  const setFilters = useCallback(
    (next: AdvancedFilterItem[]) => {
      void setState({ af: next.length > 0 ? next : null, page: null });
    },
    [setState],
  );

  return [state.af, setFilters] as const;
}
