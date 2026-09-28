"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import {
  listMediaLibrary,
  type MediaLibraryItem,
  type MediaLibraryType,
  type MediaLibraryUsageFilter,
} from "@/services/super-admin/files/mediaLibrary";

export type MediaLibraryStatus = "loading" | "ready" | "error" | "loadingMore" | "loadMoreError";

interface UseMediaLibraryOptions {
  initialType: MediaLibraryType;
  pageSize?: number;
}

export function useMediaLibrary({ initialType, pageSize = 24 }: UseMediaLibraryOptions) {
  const [type, setType] = useState<MediaLibraryType>(initialType);
  const [usage, setUsage] = useState<MediaLibraryUsageFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<MediaLibraryItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<MediaLibraryStatus>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const requestKeyRef = useRef(0);

  const applySearch = useDebouncedCallback((value: string) => {
    setSearch(value.trim());
  }, 350);

  const fetchPage = useCallback(
    async (nextPage: number, append: boolean) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const requestKey = ++requestKeyRef.current;
      setStatus(append ? "loadingMore" : "loading");

      try {
        const response = await listMediaLibrary({
          page: nextPage,
          pageSize,
          type,
          usage,
          search,
          signal: controller.signal,
        });
        if (requestKey !== requestKeyRef.current) return;
        setItems((previous) => {
          if (!append) return response.data;
          const seen = new Set(previous.map((item) => item.id));
          return [...previous, ...response.data.filter((item) => !seen.has(item.id))];
        });
        setPage(nextPage);
        setTotal(response.meta.pagination.total);
        setStatus("ready");
      } catch (error) {
        if (requestKey !== requestKeyRef.current || controller.signal.aborted) return;
        console.error("Failed to load media library", error);
        setStatus(append ? "loadMoreError" : "error");
      }
    },
    [pageSize, search, type, usage],
  );

  useEffect(() => {
    void fetchPage(1, false);
  }, [fetchPage, reloadKey]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      applySearch.cancel();
    },
    [applySearch],
  );

  const updateSearch = (value: string) => {
    setSearchInput(value);
    applySearch(value);
  };

  const clearSearch = () => {
    applySearch.cancel();
    setSearchInput("");
    setSearch("");
  };

  const loadMore = () => {
    if (status === "loading" || status === "loadingMore") return;
    void fetchPage(page + 1, true);
  };

  const retry = () => {
    if (status === "loadMoreError") {
      void fetchPage(page + 1, true);
      return;
    }
    setReloadKey((key) => key + 1);
  };

  /** Show a file uploaded inside the picker without refetching. */
  const prepend = (item: MediaLibraryItem) => {
    if (!item.mime.startsWith(`${type}/`)) return;
    setItems((previous) => [item, ...previous.filter((existing) => existing.id !== item.id)]);
    setTotal((previous) => previous + 1);
  };

  return {
    type,
    setType,
    usage,
    setUsage,
    searchInput,
    search,
    updateSearch,
    clearSearch,
    items,
    total,
    status,
    hasMore: items.length < total,
    loadMore,
    retry,
    prepend,
  };
}
