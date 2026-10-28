"use client";

import { useCallback, useMemo } from "react";
import {
  parseAsInteger,
  parseAsString,
  parseAsStringLiteral,
  useQueryStates,
} from "nuqs";
import {
  ADMIN_PRODUCT_SORTS,
  ADMIN_PRODUCT_VIEWS,
  type AdminProductSort,
  type AdminProductStockFilter,
  type AdminProductTypeFilter,
  type AdminProductView,
} from "@/services/super-admin/product/list";
import type { AdvancedFilterItem } from "@/components/SuperAdmin/Table/advancedFilters";
import { advancedFiltersParser } from "@/components/SuperAdmin/Table/advancedFiltersUrlState";
import { DEFAULT_SORT_BY_VIEW, SORTS_BY_VIEW } from "./productLifecycle";

const PARSERS = {
  view: parseAsStringLiteral(ADMIN_PRODUCT_VIEWS).withDefault("all"),
  q: parseAsString.withDefault(""),
  sort: parseAsStringLiteral(ADMIN_PRODUCT_SORTS),
  category: parseAsInteger,
  stock: parseAsStringLiteral(["in", "out"] as const),
  type: parseAsStringLiteral(["Simple", "Variable"] as const),
  af: advancedFiltersParser.withDefault([]),
  page: parseAsString.withDefault("1"),
};

/**
 * The Products list state, kept in the URL so refresh, Back/Forward and shared
 * links reproduce the same tab, search, filters, sort and page.
 *
 * Every write happens in an event handler and in one atomic update, never from
 * a mount effect: a URL write racing a `<Link>` navigation cancels it (see the
 * notes in SuperAdminTable and the products e2e). Tab, filter and sort changes
 * push a history entry; typing in search replaces it. Any change to what is
 * listed drops the page back to 1.
 */
export function useProductListQueryState() {
  const [state, setState] = useQueryStates(PARSERS, { history: "push" });

  const view = state.view as AdminProductView;
  const sort: AdminProductSort =
    state.sort && SORTS_BY_VIEW[view].includes(state.sort) ? state.sort : DEFAULT_SORT_BY_VIEW[view];

  const setView = useCallback(
    (next: AdminProductView) => {
      if (next === view) return;
      // A tab has its own natural order (Scheduled by publish time, Trash by
      // trash time), so the sort resets with it.
      void setState({ view: next === "all" ? null : next, sort: null, page: null });
    },
    [setState, view],
  );

  const setSearch = useCallback(
    (q: string) => {
      void setState({ q: q.trim() ? q : null, page: null }, { history: "replace" });
    },
    [setState],
  );

  const setSort = useCallback(
    (next: AdminProductSort) => {
      void setState({ sort: next === DEFAULT_SORT_BY_VIEW[view] ? null : next, page: null });
    },
    [setState, view],
  );

  const setCategory = useCallback(
    (categoryId: number | null) => void setState({ category: categoryId, page: null }),
    [setState],
  );
  const setStock = useCallback(
    (stock: AdminProductStockFilter | null) => void setState({ stock, page: null }),
    [setState],
  );
  const setProductType = useCallback(
    (type: AdminProductTypeFilter | null) => void setState({ type, page: null }),
    [setState],
  );
  const setAdvancedFilters = useCallback(
    (filters: AdvancedFilterItem[]) => void setState({ af: filters.length ? filters : null, page: null }),
    [setState],
  );

  const clearFilters = useCallback(
    () =>
      void setState({ q: null, category: null, stock: null, type: null, af: null, page: null }),
    [setState],
  );

  const criteria = useMemo(
    () => ({
      search: state.q,
      categoryId: state.category ?? null,
      stock: state.stock ?? null,
      productType: state.type ?? null,
      filters: state.af,
    }),
    [state.af, state.category, state.q, state.stock, state.type],
  );

  const activeFilterCount =
    (state.q.trim() ? 1 : 0) +
    (state.category ? 1 : 0) +
    (state.stock ? 1 : 0) +
    (state.type ? 1 : 0) +
    state.af.length;

  return {
    view,
    sort,
    search: state.q,
    categoryId: state.category ?? null,
    stock: state.stock ?? null,
    productType: state.type ?? null,
    advancedFilters: state.af,
    criteria,
    activeFilterCount,
    isFiltered: activeFilterCount > 0,
    setView,
    setSearch,
    setSort,
    setCategory,
    setStock,
    setProductType,
    setAdvancedFilters,
    clearFilters,
  };
}
