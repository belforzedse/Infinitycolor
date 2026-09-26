"use client";

import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { refreshTable } from "@/components/SuperAdmin/Table/refreshTableAtom";
import type { AdvancedFilterItem } from "@/components/SuperAdmin/Table/advancedFilters";
import {
  getAdminOrderCounts,
  type AdminOrderStatusCounts,
} from "@/services/super-admin/orders/list";

type Options = {
  filters: AdvancedFilterItem[];
  search: string;
  shippingMethodCodes: string[];
};

type State = {
  requestKey?: string;
  counts?: AdminOrderStatusCounts;
  activeReserveGroups?: number;
  error?: string;
};

export function useOrderStatusCounts({
  filters,
  search,
  shippingMethodCodes,
}: Options) {
  const [revision, setRevision] = useState(0);
  const tableRefresh = useAtomValue(refreshTable);
  const [state, setState] = useState<State>({});
  const filtersKey = JSON.stringify(filters);
  const shippingMethodCodesKey = JSON.stringify(shippingMethodCodes);
  const requestKey = `${search}\u0000${filtersKey}\u0000${shippingMethodCodesKey}\u0000${revision}\u0000${tableRefresh}`;

  // Row-level Anipo actions already refresh the table through this atom.
  // Keep the NeedsAttention badge count in step with the updated rows.
  useEffect(() => {
    const controller = new AbortController();

    void getAdminOrderCounts({
      filters: JSON.parse(filtersKey) as AdvancedFilterItem[],
      search,
      shippingMethodCodes: JSON.parse(shippingMethodCodesKey) as string[],
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setState({
          requestKey,
          counts: result.counts,
          activeReserveGroups: result.activeReserveGroups,
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({
          requestKey,
          error: "شمارش سفارش‌ها موقتاً در دسترس نیست.",
        });
      });

    return () => controller.abort();
  }, [filtersKey, requestKey, search, shippingMethodCodesKey]);

  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  return {
    counts: state.counts,
    activeReserveGroups: state.activeReserveGroups,
    error: state.error,
    loading: state.requestKey !== requestKey,
    refresh,
  };
}
