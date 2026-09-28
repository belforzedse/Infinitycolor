"use client";

import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { refreshTable } from "@/components/SuperAdmin/Table/refreshTableAtom";
import {
  getAdminProductCounts,
  type AdminProductCounts,
  type AdminProductCriteria,
} from "@/services/super-admin/product/list";

type State = {
  requestKey?: string;
  counts?: AdminProductCounts;
  trashRetentionDays?: number;
  error?: string;
};

/**
 * Tab badges for the Products list. Mirrors `useOrderStatusCounts`: the same
 * search and filters the table uses narrow every bucket, the tab itself does
 * not, and a table refresh (after any lifecycle action) recounts.
 */
export function useProductLifecycleCounts(criteria: AdminProductCriteria) {
  const [revision, setRevision] = useState(0);
  const tableRefresh = useAtomValue(refreshTable);
  const [state, setState] = useState<State>({});
  const criteriaKey = JSON.stringify(criteria);
  const requestKey = `${criteriaKey}\u0000${revision}\u0000${tableRefresh}`;

  useEffect(() => {
    const controller = new AbortController();
    void getAdminProductCounts({
      ...(JSON.parse(criteriaKey) as AdminProductCriteria),
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setState({
          requestKey,
          counts: result.counts,
          trashRetentionDays: result.trashRetentionDays,
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({ requestKey, error: "شمارش محصولات موقتاً در دسترس نیست." });
      });
    return () => controller.abort();
  }, [criteriaKey, requestKey]);

  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  return {
    counts: state.counts,
    trashRetentionDays: state.trashRetentionDays,
    error: state.error,
    loading: state.requestKey !== requestKey,
    refresh,
  };
}
