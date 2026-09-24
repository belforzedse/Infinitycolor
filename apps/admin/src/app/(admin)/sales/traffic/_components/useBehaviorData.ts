"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BehaviorQuery,
  BehaviorResponse,
  BehaviorView,
  ConversionDetailRequest,
} from "@/types/super-admin/reports/behavior";
import {
  getBehaviorView,
  getConversionDetail,
} from "@/services/super-admin/reports/behavior";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import { tehranToday } from "../format";

export type Resource = {
  report: BehaviorResponse | null;
  /** True while a request is in flight; `report` keeps the previous answer meanwhile. */
  loading: boolean;
  requestError: string | null;
  reload: (fresh?: boolean) => void;
};

function isAbort(error: unknown): boolean {
  return (error as { name?: string })?.name === "AbortError";
}

/**
 * One behavior request with abort-on-change. The previous report stays on
 * screen while the next one loads, so a refetch dims the section instead of
 * collapsing it to a skeleton.
 */
function useResource(
  /** What the data *is* (a view, a drill-down); a report never outlives its scope. */
  scope: string | null,
  key: string | null,
  fetcher: (signal: AbortSignal, fresh: boolean) => Promise<BehaviorResponse>,
  fallbackError: string,
): Resource {
  const [held, setHeld] = useState<{ scope: string; report: BehaviorResponse } | null>(null);
  const [loading, setLoading] = useState(Boolean(key));
  const [requestError, setRequestError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const run = useCallback(
    async (fresh: boolean, runScope: string) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      setRequestError(null);
      try {
        const result = await fetcherRef.current(controller.signal, fresh);
        if (!controller.signal.aborted) setHeld({ scope: runScope, report: result });
      } catch (error) {
        if (controller.signal.aborted || isAbort(error)) return;
        setHeld(null);
        setRequestError(getUserFacingErrorMessage(error, fallbackError));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [fallbackError],
  );

  useEffect(() => {
    if (!key || !scope) {
      controllerRef.current?.abort();
      setLoading(false);
      return;
    }
    // The fetcher reads the latest render's query; make sure it is in place first.
    fetcherRef.current = fetcher;
    void run(false, scope);
    return () => controllerRef.current?.abort();
    // `fetcher` changes identity every render; `key` is what identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scope, run]);

  const reload = useCallback(
    (fresh = true) => {
      if (key && scope) void run(fresh, scope);
    },
    [key, scope, run],
  );

  return {
    report: held && held.scope === scope ? held.report : null,
    loading,
    requestError,
    reload,
  };
}

export function queryKey(query: BehaviorQuery): string {
  return JSON.stringify([query.start, query.end, query.comparison, query.filters ?? {}]);
}

export function useBehaviorView(view: BehaviorView | null, query: BehaviorQuery): Resource {
  const key = view ? `${view}:${queryKey(query)}` : null;
  return useResource(
    view,
    key,
    (signal, fresh) => getBehaviorView(view as BehaviorView, query, { signal, fresh }),
    "خطا در بارگذاری گزارش رفتار کاربران",
  );
}

export function useConversionDetail(
  request: ConversionDetailRequest | null,
  query: BehaviorQuery,
): Resource {
  const scope = request ? JSON.stringify(request) : null;
  const key = scope ? `${scope}:${queryKey(query)}` : null;
  return useResource(
    scope,
    key,
    (signal, fresh) =>
      getConversionDetail(query, request as ConversionDetailRequest, { signal, fresh }),
    "خطا در بارگذاری جزئیات قیف",
  );
}

/**
 * Realtime: polls only while the page is visible, faster while the panel is
 * open. The backend caches realtime for ten seconds, so this stays cheap.
 */
export function useRealtime(expanded: boolean): Resource {
  // Realtime has no period; a fixed query keeps period and filter changes from refetching it.
  const query = useMemo<BehaviorQuery>(() => {
    const today = tehranToday();
    return { start: today, end: today, comparison: "none" };
  }, []);
  const resource = useBehaviorView("realtime", query);
  const { reload } = resource;
  useEffect(() => {
    const interval = window.setInterval(
      () => {
        if (!document.hidden) reload(true);
      },
      expanded ? 30_000 : 60_000,
    );
    const onVisibility = () => {
      if (!document.hidden) reload(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [expanded, reload]);
  return resource;
}
