"use client";

import type { ColumnDef, SortingState, Row } from "@tanstack/react-table";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";
// removed unused import: getPaginationRowModel from "@tanstack/react-table"
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  groupTableRows,
  type RowGroupHeaderProps,
  type TableRowGrouping,
} from "./rowGrouping";
import { cn } from "@/utils/tailwind";
import { twMerge } from "tailwind-merge";
import DragIcon from "../Layout/Icons/DragIcon";
import { apiClient } from "@/services";
import { useAtom } from "jotai";
import { refreshTable } from "./refreshTableAtom";
export { refreshTable } from "./refreshTableAtom";
import { useQueryState } from "nuqs";
import ReportTableSkeleton from "@/components/Skeletons/ReportTableSkeleton";
import { apiCache } from "@/lib/api-cache";
import { AnimatedTableRow } from "./AnimatedTableRow";
import { EmptyState, ErrorState, FilteredEmptyState } from "@/components/admin";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import toast from "react-hot-toast";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import BulkActionsToolbar from "./BulkActionsToolbar";
import {
  bulkConfirmDescription,
  resolveBulkConfirm,
  type BulkActionContext,
  type BulkActionOption,
} from "./bulkActions";
import {
  buildSuperAdminTableRequestUrl,
  parseAdvancedFiltersParam,
  serializeAdvancedFiltersParam,
  useAdvancedFilterFields,
  type AdvancedFilterItem,
} from "./advancedFilters";

declare module "@tanstack/table-core" {
  interface ColumnMeta<TData, TValue> {
    headerClassName?: string;
    cellClassName?: string;
    __?: Record<string, TValue>;
    ___?: Record<string, TData>;
  }
}

interface TableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  rowGrouping?: TableRowGrouping<TData>;
  data?: TData[];
  url?: string;
  loading?: boolean;
  className?: string;
  draggable?: boolean;
  mobileTable?: (
    data: TData[] | undefined,
    selectionProps?: {
      enableSelection: boolean;
      selectedIds: Set<string>;
      onSelectionChange: (id: string, selected: boolean) => void;
    },
  ) => React.ReactNode;
  onItemDrag?: (row: Row<TData>) => void;
  // Enable row selection + bulk actions
  enableSelection?: boolean;
  getRowId?: (row: TData) => string;
  bulkOptions?: BulkActionOption[];
  onBulkAction?: (
    actionId: string,
    selectedRows: TData[],
    context?: BulkActionContext,
  ) => void | Promise<void>;
  // Optional client-side sorting when API sort is not feasible
  clientSort?:
    | undefined
    | {
        key: string;
        direction: "asc" | "desc";
        getValue: (row: TData) => number;
      };
  filters?: AdvancedFilterItem[];
  /**
   * Rendered when the fetch succeeded but returned nothing. Omit to get the
   * shared default, which distinguishes a genuinely empty resource from a
   * search/filter that matched nothing (see `isFiltered`/`onClearFilters`).
   */
  emptyState?: React.ReactNode;
  /**
   * Set when a search term or filter is narrowing the result set, so the empty
   * state can offer to clear it instead of implying the resource is empty.
   */
  isFiltered?: boolean;
  onClearFilters?: () => void;
  /** Rendered when the fetch failed. Defaults to a retryable ErrorState. */
  errorState?: React.ReactNode;
  dataLoaderKey?: string;
  refreshOnVisibility?: boolean;
  dataLoader?: (input: {
    page: number;
    pageSize: number;
    filters: AdvancedFilterItem[];
    signal: AbortSignal;
  }) => Promise<{
    data: TData[];
    meta?: {
      pagination?: {
        page: number;
        pageSize: number;
        pageCount: number;
        total: number;
      };
      recycleCount?: number;
    };
  }>;
  onMetaChange?: (meta: {
    pagination?: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
    recycleCount?: number;
  }) => void;
}

// Strapi-like response meta is returned by our ApiClient as ApiResponse<T>

export function SuperAdminTable<TData, TValue>({
  columns,
  rowGrouping,
  data,
  url,
  loading,
  className,
  draggable,
  onItemDrag,
  mobileTable,
  enableSelection,
  getRowId,
  bulkOptions,
  onBulkAction,
  clientSort,
  filters,
  emptyState,
  isFiltered,
  onClearFilters,
  errorState,
  dataLoaderKey,
  refreshOnVisibility = true,
  dataLoader,
  onMetaChange,
}: TableProps<TData, TValue>) {
  const filterFields = useAdvancedFilterFields();
  const [urlFilters] = useQueryState<AdvancedFilterItem[]>("filter", {
    defaultValue: [],
    parse: parseAdvancedFiltersParam,
    serialize: serializeAdvancedFiltersParam,
  });
  const activeFilters = filters ?? urlFilters;

  const [totalSize, setTotalSize] = useQueryState("totalSize", {
    defaultValue: 0,
    parse: (value) => parseInt(value || "0"),
    serialize: (value) => value.toString(),
  });
  const totalSizeRef = useRef(totalSize);
  totalSizeRef.current = totalSize;

  const [page] = useQueryState("page", { defaultValue: "1" });
  const [pageSize] = useQueryState("pageSize", {
    defaultValue: "25",
  });

  const [sorting, setSorting] = useState<SortingState>([]);
  const [tableData, setTableData] = useState(data);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<string>("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [pendingBulkAction, setPendingBulkAction] =
    useState<BulkActionOption | null>(null);
  const [bulkConfirmInput, setBulkConfirmInput] = useState("");
  const [draggedRow, setDraggedRow] = useState<Row<TData> | null>(null);
  const [dragOverRow, setDragOverRow] = useState<Row<TData> | null>(null);
  const [internalLoading, setInternalLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refresh, setRefresh] = useAtom(refreshTable);
  const [isPageTransitioning, setIsPageTransitioning] = useState(false);
  const [newlyAddedIds, setNewlyAddedIds] = useState<Set<string>>(new Set());
  const previousDataRef = useRef<TData[]>([]);
  const animationContextRef = useRef<string | null>(null);
  const newRowsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pageTransitionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const fetchSeqRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fetchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const hasScheduledFetchRef = useRef(false);
  const lastPageRef = useRef(page);

  const requestUrl = useMemo(() => {
    if (!url) return null;

    return buildSuperAdminTableRequestUrl({
      url,
      page,
      pageSize,
      filters: activeFilters,
      filterFields,
    });
  }, [url, page, pageSize, activeFilters, filterFields]);

  const requestKey = useMemo(
    () =>
      requestUrl ??
      (dataLoader
        ? `data-loader:${page}:${pageSize}:${dataLoaderKey ?? "default"}:${JSON.stringify(activeFilters)}`
        : null),
    [activeFilters, dataLoader, dataLoaderKey, page, pageSize, requestUrl],
  );

  const lastRequestKeyRef = useRef<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<{
    context: string | null;
    keys: Set<string>;
  }>({ context: requestKey, keys: new Set() });

  const isGroupExpanded = (key: string) =>
    expandedGroups.context === requestKey && expandedGroups.keys.has(key);

  // Helper function to resolve row keys consistently
  const resolveRowKey = useCallback(
    (rowData: TData | undefined) => {
      const key = getRowId?.(rowData as TData) ?? (rowData as any)?.id ?? "";
      return String(key);
    },
    [getRowId],
  );

  const allRowsSelected =
    !!tableData &&
    selectedIds.size > 0 &&
    selectedIds.size === tableData.length;

  const toggleAllRows = useCallback(
    (checked: boolean) => {
      if (!tableData) return;
      const next = new Set<string>();
      if (checked) tableData.forEach((row) => next.add(resolveRowKey(row)));
      setSelectedIds(next);
    },
    [resolveRowKey, tableData],
  );

  /**
   * Keeps the selection to rows that actually exist in the current result set.
   *
   * Selection is scoped to what is on screen — `toggleAllRows` only ever selects
   * the current page, and `executeBulkAction` resolves rows out of `tableData` —
   * but the ids used to survive a page or filter change, so the header checkbox
   * and the "N selected" badge could both describe rows nobody could see and no
   * action would touch. Pruning here also covers the case that matters after a
   * bulk action: rows whose new status drops them out of the active tab go away,
   * while every surviving row stays checked.
   *
   * `runFetch` only assigns `tableData` on success, leaving the previous array in
   * place while loading and on error, so there is no transient empty state to
   * prune against. The size check keeps the Set identity stable when nothing was
   * removed, so this cannot loop or churn on every refetch.
   */
  useEffect(() => {
    if (!hasLoadedOnce || !tableData) return;
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      const visible = new Set(tableData.map((row) => resolveRowKey(row)));
      const next = new Set<string>();
      current.forEach((id) => {
        if (visible.has(id)) next.add(id);
      });
      return next.size === current.size ? current : next;
    });
  }, [hasLoadedOnce, resolveRowKey, tableData]);

  /**
   * Runs a bulk action and waits for it.
   *
   * The selection is deliberately NOT cleared here. Clearing it meant an operator
   * who wanted a second action on the same rows had to re-pick every one, and it
   * fired even when the action failed outright or skipped every row — neither
   * page handler rejects, they report through toasts and return normally. Rows
   * that genuinely leave the result set are dropped by the prune effect below
   * once the refreshed data arrives.
   */
  const executeBulkAction = useCallback(
    async (option: BulkActionOption, context?: BulkActionContext) => {
      if (!onBulkAction || !tableData || option.disabled) return;
      if (selectedIds.size === 0) {
        toast.error("هیچ ردیفی انتخاب نشده است");
        return;
      }
      const rows = tableData.filter((row) =>
        selectedIds.has(resolveRowKey(row)),
      );
      setBulkBusy(true);
      try {
        await onBulkAction(option.id, rows, context);
        setBulkAction("");
      } catch (error) {
        console.error("Bulk action failed:", error);
        toast.error(
          getUserFacingErrorMessage(error, "انجام عملیات دسته‌جمعی ناموفق بود"),
        );
      } finally {
        setBulkBusy(false);
      }
    },
    [onBulkAction, resolveRowKey, selectedIds, tableData],
  );

  const requestBulkAction = useCallback(() => {
    const option = (bulkOptions || []).find((item) => item.id === bulkAction);
    if (!option) return;
    const confirm = resolveBulkConfirm(option);
    if (confirm) {
      setBulkConfirmInput(confirm.input?.defaultValue ?? "");
      setPendingBulkAction(option);
      return;
    }
    void executeBulkAction(option);
  }, [bulkAction, bulkOptions, executeBulkAction]);

  const pendingBulkConfirm = pendingBulkAction
    ? resolveBulkConfirm(pendingBulkAction)
    : null;
  const bulkConfirmInputError =
    pendingBulkConfirm?.input?.validate?.(bulkConfirmInput) ?? null;

  const closeBulkConfirm = useCallback(() => {
    if (bulkBusy) return;
    setPendingBulkAction(null);
    setBulkConfirmInput("");
  }, [bulkBusy]);

  const clearNewRowsTimeout = useCallback(() => {
    if (newRowsTimeoutRef.current) {
      clearTimeout(newRowsTimeoutRef.current);
      newRowsTimeoutRef.current = null;
    }
  }, []);

  const updateAnimationState = useCallback(
    (nextData: TData[], contextKey: string) => {
      const previousContext = animationContextRef.current;
      const contextChanged = previousContext !== contextKey;

      // Reset animation tracking when context (url/page/filter) changes or on first load
      if (contextChanged || !hasLoadedOnce) {
        clearNewRowsTimeout();
        if (contextChanged) {
          setNewlyAddedIds(new Set());
        }
        animationContextRef.current = contextKey;
        previousDataRef.current = nextData;
        return;
      }

      const previousIds = new Set(
        previousDataRef.current.map((item) => resolveRowKey(item)),
      );
      const addedIds = nextData
        .map((item) => resolveRowKey(item))
        .filter((id) => id && !previousIds.has(id));

      if (addedIds.length > 0) {
        setNewlyAddedIds(new Set(addedIds));
        clearNewRowsTimeout();
        newRowsTimeoutRef.current = setTimeout(
          () => setNewlyAddedIds(new Set()),
          700,
        );
      }

      animationContextRef.current = contextKey;
      previousDataRef.current = nextData;
    },
    [clearNewRowsTimeout, hasLoadedOnce, resolveRowKey],
  );

  const runFetch = useCallback(
    async (
      key: string,
      {
        force = false,
        silent = false,
      }: { force?: boolean; silent?: boolean } = {},
    ) => {
      const useSilent = silent && hasLoadedOnce;

      // Avoid duplicate fetch for identical inputs unless explicitly refreshed.
      if (!force && lastRequestKeyRef.current === key) return;
      lastRequestKeyRef.current = key;

      // A page/filter/search change supersedes the previous read.
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // When forcing refresh, clear cache for this specific URL pattern
      if (force && requestUrl) {
        apiCache.clearByPattern(
          new RegExp(requestUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        );
      }

      const seq = ++fetchSeqRef.current;
      if (!useSilent) {
        setInternalLoading(true);
      }
      try {
        const res = dataLoader
          ? await dataLoader({
              page: Number(page),
              pageSize: Number(pageSize),
              filters: activeFilters,
              signal: controller.signal,
            })
          : await apiClient.get<TData[]>(requestUrl as string, {
              cache: force ? "no-store" : "default",
              signal: controller.signal,
            });

        if (seq === fetchSeqRef.current) {
          const payload = Array.isArray(res) ? res : (res as any)?.data;
          const newData = (payload as TData[]) ?? [];
          const contextKey = key || "local-data";

          updateAnimationState(newData, contextKey);
          setTableData(newData);
          setHasLoadedOnce(true);

          if (isPageTransitioning) {
            if (pageTransitionTimeoutRef.current) {
              clearTimeout(pageTransitionTimeoutRef.current);
            }
            pageTransitionTimeoutRef.current = setTimeout(() => {
              setIsPageTransitioning(false);
            }, 320);
          }

          const total =
            (res as any)?.meta?.pagination?.total ??
            (Array.isArray(payload) ? payload.length : 0) ??
            0;

          // Avoid redundant history.replaceState writes — they cancel in-flight
          // soft navigations away from the list (e.g. row edit Links).
          if (totalSizeRef.current !== total) {
            void setTotalSize(total);
          }
          setFetchError(null);
          onMetaChange?.((res as any)?.meta ?? {});
        }
      } catch (error) {
        const aborted =
          controller.signal.aborted || (error as any)?.name === "AbortError";

        if (!aborted && seq === fetchSeqRef.current) {
          // A failed load used to be indistinguishable from an empty resource:
          // the error was swallowed and the table rendered "no data".
          setFetchError(
            getUserFacingErrorMessage(error, "بارگذاری اطلاعات ناموفق بود"),
          );
        }

        if (!aborted && process.env.NODE_ENV === "development") {
          console.error("Failed to fetch table data:", error);
        }
      } finally {
        if (seq === fetchSeqRef.current) {
          if (!useSilent) {
            setInternalLoading(false);
          }
          if (abortControllerRef.current === controller) {
            abortControllerRef.current = null;
          }
        }
      }
    },
    [
      activeFilters,
      dataLoader,
      hasLoadedOnce,
      isPageTransitioning,
      onMetaChange,
      page,
      pageSize,
      requestUrl,
      setTotalSize,
      updateAnimationState,
    ],
  );

  // Fetch on first mount and when the computed request URL changes
  useEffect(() => {
    if (!requestKey) return;

    if (fetchDebounceRef.current) {
      clearTimeout(fetchDebounceRef.current);
    }

    // The first request paints immediately. Pages already debounce their own
    // search inputs, so debouncing the initial load too just added ~300ms of
    // blank list to every navigation.
    if (!hasScheduledFetchRef.current) {
      hasScheduledFetchRef.current = true;
      runFetch(requestKey);
      return;
    }

    fetchDebounceRef.current = setTimeout(() => {
      runFetch(requestKey);
      fetchDebounceRef.current = null;
    }, 300);

    return () => {
      if (fetchDebounceRef.current) {
        clearTimeout(fetchDebounceRef.current);
        fetchDebounceRef.current = null;
      }
    };
  }, [requestKey, runFetch]);

  // External refresh trigger (e.g. after mutations)
  useEffect(() => {
    if (refresh && requestKey) {
      runFetch(requestKey, { force: true, silent: true });
      setRefresh(false);
    }
  }, [refresh, requestKey, runFetch, setRefresh]);

  // Set up visibility change listener for page focus - refresh when page becomes visible
  useEffect(() => {
    if (!refreshOnVisibility) return;

    const handleVisibilityChange = () => {
      // Refresh data when page becomes visible (switched back from another tab)
      if (!document.hidden && requestKey) {
        // Silent refresh to avoid visual skeleton; animations will handle diffs
        runFetch(requestKey, { force: true, silent: true });
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshOnVisibility, requestKey, runFetch]);

  // Track page transitions to swap animation style (fade only on page change)
  useEffect(() => {
    if (lastPageRef.current !== page) {
      setIsPageTransitioning(true);
      lastPageRef.current = page;
    }
  }, [page]);

  // Note: Automatic polling has been disabled on super admin pages to prevent
  // conflicts when admins are editing data. Data will update on manual refresh or
  // after mutations (e.g., item deletion, status change).
  // Users can manually refresh the page to see the latest data.
  useEffect(() => {
    // Polling disabled - admins should manually refresh to get latest data
    // This prevents the table from updating while an admin is in the middle of editing
    return () => {
      // Cleanup placeholder
    };
  }, []);

  // Keep internal data in sync when data prop is provided (non-URL usage)
  useEffect(() => {
    if (data !== undefined) {
      const safeData = data ?? [];
      const contextKey = requestUrl ?? "local-data";
      updateAnimationState(safeData, contextKey);
      setTableData(safeData);
      setHasLoadedOnce(true);
    }
  }, [data, requestUrl, updateAnimationState]);

  useEffect(() => {
    return () => {
      clearNewRowsTimeout();
      if (pageTransitionTimeoutRef.current) {
        clearTimeout(pageTransitionTimeoutRef.current);
      }
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [clearNewRowsTimeout]);

  const table = useReactTable({
    data: useMemo(() => {
      if (!tableData) return [] as TData[];
      if (!clientSort) return tableData;

      const factor = clientSort.direction === "asc" ? 1 : -1;

      return [...tableData].sort((a, b) => {
        const va = Number(clientSort.getValue(a) ?? 0);
        const vb = Number(clientSort.getValue(b) ?? 0);
        if (va === vb) return 0;
        return va > vb ? factor : -1 * factor;
      });
    }, [tableData, clientSort]) as TData[],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  });

  const rowSections = groupTableRows(
    table.getRowModel().rows,
    rowGrouping ? (row) => rowGrouping.getKey(row.original) : undefined,
  );

  const renderGroupHeader = (groupKey: string, rows: Row<TData>[]) => {
    const members = rows.map((row) => row.original);
    const memberIds = members.map(resolveRowKey);
    const selectedCount = memberIds.filter((id) => selectedIds.has(id)).length;
    const props: RowGroupHeaderProps<TData> = {
      groupKey,
      rows: members,
      expanded: isGroupExpanded(groupKey),
      onToggle: () => {
        setExpandedGroups((previous) => {
          const keys = new Set(
            previous.context === requestKey ? previous.keys : [],
          );
          if (keys.has(groupKey)) keys.delete(groupKey);
          else keys.add(groupKey);
          return { context: requestKey, keys };
        });
      },
      selection: enableSelection
        ? {
            checked: selectedCount === memberIds.length,
            indeterminate:
              selectedCount > 0 && selectedCount < memberIds.length,
            onChange: (checked) => {
              setSelectedIds((previous) => {
                const next = new Set(previous);
                memberIds.forEach((id) => {
                  if (checked) next.add(id);
                  else next.delete(id);
                });
                return next;
              });
            },
          }
        : undefined,
    };
    return rowGrouping?.renderHeader(props);
  };

  const handleDragStart = (row: Row<TData>) => {
    setDraggedRow(row);
  };

  const handleDragOver = (e: React.DragEvent, row: Row<TData>) => {
    e.preventDefault();
    setDragOverRow(row);
  };

  const handleDrop = (e: React.DragEvent, targetRow: Row<TData>) => {
    e.preventDefault();
    if (!draggedRow || !tableData) return;

    const newData = [...tableData];
    const draggedRowIndex = draggedRow.index;
    const targetRowIndex = targetRow.index;

    // Swap positions
    [newData[draggedRowIndex], newData[targetRowIndex]] = [
      newData[targetRowIndex],
      newData[draggedRowIndex],
    ];

    setTableData(newData);
    setDraggedRow(null);
    setDragOverRow(null);
    onItemDrag?.(targetRow);
  };

  const isLoading = loading ?? internalLoading;
  const showSkeleton = isLoading && (isPageTransitioning || !hasLoadedOnce);
  // A search or filter narrowing the results is a different situation from an
  // empty resource, and the two used to render the same generic box.
  const hasNarrowingFilter = isFiltered ?? (activeFilters?.length ?? 0) > 0;
  const resolvedEmptyState = fetchError
    ? (errorState ?? (
        <ErrorState
          description={fetchError}
          onRetry={() => requestKey && runFetch(requestKey, { force: true })}
        />
      ))
    : (emptyState ??
      (hasNarrowingFilter ? (
        <FilteredEmptyState onClearFilters={onClearFilters} />
      ) : (
        <EmptyState title="داده‌ای برای نمایش وجود ندارد" />
      )));

  // One boundary for every list in the admin. This used to flip between 768px
  // and 1024px depending on whether a `mobileTable` prop happened to be passed,
  // so two lists on the same screen width could disagree about their layout.
  const cardLayoutClassName = "block lg:hidden";
  const tableLayoutClassName =
    "hidden min-w-0 w-full overflow-x-auto overflow-y-clip lg:block";

  const mobileSelectionProps = enableSelection
    ? {
        enableSelection: true,
        selectedIds,
        onSelectionChange: (id: string, selected: boolean) => {
          setSelectedIds((previous) => {
            const next = new Set(previous);
            if (selected) next.add(id);
            else next.delete(id);
            return next;
          });
        },
      }
    : undefined;

  return (
    <div className="w-full">
      {/* Mobile header controls */}
      <div className={cardLayoutClassName}>
        <div className="flex flex-col gap-2">
          {enableSelection && (
            <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2">
              <BulkActionsToolbar
                compact
                options={bulkOptions || []}
                selectedCount={selectedIds.size}
                allSelected={allRowsSelected}
                onToggleAll={toggleAllRows}
                selectedActionId={bulkAction}
                onSelectAction={setBulkAction}
                onExecute={requestBulkAction}
                busy={bulkBusy}
              />
            </div>
          )}
        </div>
      </div>

      {/* Desktop table */}
      <div className={tableLayoutClassName}>
        <div className="relative">
          <table className={cn("w-full caption-bottom text-sm", className)}>
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr className="rounded-2xl bg-slate-50" key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    return (
                      <th
                        key={header.id}
                        className={twMerge(
                          "text-foreground-primary h-12 px-2 text-right align-middle text-sm font-normal md:px-3 lg:px-4",
                          header.column.columnDef.meta?.headerClassName,
                        )}
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                      </th>
                    );
                  })}
                </tr>
              ))}

              {enableSelection && (
                <tr>
                  <td colSpan={columns.length}>
                    <div className="my-3 flex h-auto w-full items-center justify-between px-4">
                      <BulkActionsToolbar
                        options={bulkOptions || []}
                        selectedCount={selectedIds.size}
                        allSelected={allRowsSelected}
                        onToggleAll={toggleAllRows}
                        selectedActionId={bulkAction}
                        onSelectAction={setBulkAction}
                        onExecute={requestBulkAction}
                        busy={bulkBusy}
                      />
                    </div>
                  </td>
                </tr>
              )}
            </thead>

            <tbody>
              {showSkeleton ? (
                <ReportTableSkeleton columns={columns.length} />
              ) : table.getRowModel().rows?.length ? (
                <>
                  {rowSections.map((section) => (
                    <Fragment
                      key={
                        section.groupKey
                          ? `group:${section.groupKey}`
                          : `rows:${section.rows[0].id}`
                      }
                    >
                      {section.groupKey && (
                        <tr className="border-y border-infinity-primary/20 bg-infinity-primary/5">
                          <td colSpan={columns.length}>
                            {renderGroupHeader(section.groupKey, section.rows)}
                          </td>
                        </tr>
                      )}
                      {(!section.groupKey ||
                        isGroupExpanded(section.groupKey)) &&
                        section.rows.map((row) => {
                          const resolvedKey = resolveRowKey(
                            row.original as TData,
                          );
                          const rowKey = resolvedKey || String(row.id); // fallback avoids empty/unstable keys
                          const isNew = rowKey
                            ? newlyAddedIds.has(rowKey)
                            : false;

                          return (
                            <AnimatedTableRow
                              key={rowKey}
                              rowKey={rowKey}
                              isNew={isNew}
                              isPageTransitioning={isPageTransitioning}
                              draggable={draggable}
                              onDragStart={() => handleDragStart(row)}
                              onDragOver={(e) => handleDragOver(e, row)}
                              onDrop={(e) => handleDrop(e, row)}
                              className={twMerge(
                                // IMPORTANT: avoid `transition-all` (conflicts with Framer transforms)
                                "border-b border-gray-200 transition-colors hover:bg-gray-50/50",
                                section.groupKey &&
                                  "border-x border-infinity-primary/20 bg-infinity-primary/[0.02]",
                                // IMPORTANT: outline doesn't affect layout height
                                dragOverRow?.id === row.id &&
                                  "outline outline-2 -outline-offset-2 outline-blue-500",
                              )}
                            >
                              {row.getVisibleCells().map((cell, index) => (
                                <td
                                  key={cell.id}
                                  className={twMerge(
                                    "p-2 text-right align-middle md:p-3 lg:p-4 [&:has([role=checkbox])]:pr-0",
                                    cell.column.columnDef.meta?.cellClassName,
                                  )}
                                >
                                  {index === 0 && enableSelection ? (
                                    <div className="flex items-center gap-2">
                                      {draggable && (
                                        <div className="cursor-move">
                                          <DragIcon />
                                        </div>
                                      )}
                                      <input
                                        type="checkbox"
                                        checked={selectedIds.has(rowKey)}
                                        onChange={(e) => {
                                          const next = new Set(selectedIds);
                                          if (e.target.checked)
                                            next.add(rowKey);
                                          else next.delete(rowKey);
                                          setSelectedIds(next);
                                        }}
                                      />
                                      {flexRender(
                                        cell.column.columnDef.cell,
                                        cell.getContext(),
                                      )}
                                    </div>
                                  ) : (
                                    flexRender(
                                      cell.column.columnDef.cell,
                                      cell.getContext(),
                                    )
                                  )}
                                </td>
                              ))}
                            </AnimatedTableRow>
                          );
                        })}
                    </Fragment>
                  ))}
                </>
              ) : (
                <tr>
                  <td colSpan={columns.length}>{resolvedEmptyState}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards/table alternative */}
      <div className={cardLayoutClassName}>
        {mobileTable && rowGrouping && showSkeleton ? (
          <div className="mt-3 flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="h-28 animate-pulse rounded-2xl border border-slate-100 bg-white"
              />
            ))}
          </div>
        ) : mobileTable && rowGrouping && rowSections.length > 0 ? (
          <div className="mt-2 flex flex-col gap-2">
            {rowSections.map((section) =>
              section.groupKey ? (
                <section
                  key={`group:${section.groupKey}`}
                  className="overflow-hidden rounded-2xl border border-infinity-primary/20 bg-infinity-primary/5"
                >
                  {renderGroupHeader(section.groupKey, section.rows)}
                  {isGroupExpanded(section.groupKey) && (
                    <div className="border-t border-infinity-primary/20 px-2 pb-2">
                      {mobileTable(
                        section.rows.map((row) => row.original),
                        mobileSelectionProps,
                      )}
                    </div>
                  )}
                </section>
              ) : (
                <Fragment key={`rows:${section.rows[0].id}`}>
                  {mobileTable(
                    section.rows.map((row) => row.original),
                    mobileSelectionProps,
                  )}
                </Fragment>
              ),
            )}
          </div>
        ) : mobileTable && rowGrouping ? (
          <div className="mt-3 rounded-2xl border border-slate-100 bg-white">
            {resolvedEmptyState}
          </div>
        ) : mobileTable ? (
          mobileTable(tableData, mobileSelectionProps)
        ) : showSkeleton ? (
          <div className="mt-3 flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="h-28 animate-pulse rounded-2xl border border-slate-100 bg-white"
              />
            ))}
          </div>
        ) : table.getRowModel().rows?.length ? (
          <div className="mt-3 flex flex-col gap-3">
            {table.getRowModel().rows.map((row) => {
              const resolvedKey = resolveRowKey(row.original as TData);
              const rowKey = resolvedKey || String(row.id);
              const visibleCells = row.getVisibleCells();
              const [headlineCell, ...detailCells] = visibleCells;

              return (
                <article
                  key={rowKey}
                  className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    {enableSelection && (
                      <input
                        type="checkbox"
                        className="mt-1 h-5 w-5 shrink-0"
                        checked={selectedIds.has(rowKey)}
                        onChange={(e) => {
                          const next = new Set(selectedIds);
                          if (e.target.checked) next.add(rowKey);
                          else next.delete(rowKey);
                          setSelectedIds(next);
                        }}
                        aria-label="انتخاب ردیف"
                      />
                    )}

                    {draggable && (
                      <div className="mt-1 shrink-0 cursor-move">
                        <DragIcon />
                      </div>
                    )}

                    <div className="min-w-0 flex-1 space-y-3">
                      {headlineCell && (
                        <div className="min-w-0 text-sm font-medium text-slate-900 [&_*]:max-w-full [&_*]:break-words">
                          {flexRender(
                            headlineCell.column.columnDef.cell,
                            headlineCell.getContext(),
                          )}
                        </div>
                      )}

                      <dl className="grid grid-cols-1 gap-2">
                        {detailCells.map((cell) => {
                          const header = cell.column.columnDef.header;
                          const label =
                            typeof header === "string"
                              ? header
                              : cell.column.id;

                          return (
                            <div
                              key={cell.id}
                              className="flex min-w-0 items-start justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2"
                            >
                              <dt className="shrink-0 text-xs text-slate-400">
                                {label}
                              </dt>
                              <dd className="min-w-0 text-left text-xs text-slate-700 [&_*]:max-w-full [&_*]:break-words">
                                {flexRender(
                                  cell.column.columnDef.cell,
                                  cell.getContext(),
                                )}
                              </dd>
                            </div>
                          );
                        })}
                      </dl>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="mt-3 rounded-2xl border border-slate-100 bg-white">
            {resolvedEmptyState}
          </div>
        )}
      </div>

      {/*
        Rendered at the component root, not inside the <thead> cell that hosts the
        desktop toolbar: that cell re-renders on every selection change, and
        Modal's focus trap and scroll lock do not survive remounting well.
      */}
      {pendingBulkAction && pendingBulkConfirm && (
        <ConfirmDialog
          isOpen
          variant={
            pendingBulkAction.variant === "danger" ? "danger" : "default"
          }
          title={pendingBulkConfirm.title ?? "تأیید عملیات"}
          description={bulkConfirmDescription(
            pendingBulkConfirm,
            selectedIds.size,
          )}
          confirmText={
            bulkBusy
              ? "در حال انجام..."
              : (pendingBulkConfirm.confirmText ?? pendingBulkAction.title)
          }
          cancelText={pendingBulkConfirm.cancelText ?? "انصراف"}
          confirmDisabled={bulkBusy || Boolean(bulkConfirmInputError)}
          onCancel={closeBulkConfirm}
          onConfirm={() => {
            if (bulkConfirmInputError) return;
            const option = pendingBulkAction;
            const input = pendingBulkConfirm.input
              ? bulkConfirmInput
              : undefined;
            setPendingBulkAction(null);
            setBulkConfirmInput("");
            void executeBulkAction(
              option,
              input !== undefined ? { input } : undefined,
            );
          }}
        >
          {pendingBulkConfirm.input && (
            <div className="flex flex-col gap-1.5 text-right">
              <label className="text-sm text-neutral-700">
                {pendingBulkConfirm.input.label}
              </label>
              <input
                type={pendingBulkConfirm.input.type}
                min={pendingBulkConfirm.input.min}
                placeholder={pendingBulkConfirm.input.placeholder}
                value={bulkConfirmInput}
                autoFocus
                onChange={(event) => setBulkConfirmInput(event.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-actions-primary/30"
                data-testid="bulk-confirm-input"
              />
              {bulkConfirmInputError && (
                <span className="text-xs text-red-600">
                  {bulkConfirmInputError}
                </span>
              )}
            </div>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
