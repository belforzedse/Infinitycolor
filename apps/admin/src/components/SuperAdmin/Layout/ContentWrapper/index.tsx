"use client";

import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { apiClient } from "@/services";
import { refreshTable } from "@/components/SuperAdmin/Table";
import SuperAdminPagination from "../../Pagination";
import SuperAdminPageSizeSelect from "../../Pagination/PageSizeSelect";
import RecycleBinButton from "./Button/RecycleBin";
import AddButton from "./Button/Add";
import FilterButton from "./Button/Filter";
import {
  AdvancedFilterFieldsProvider,
  type AdvancedFilterField,
  type AdvancedFilterItem,
} from "@/components/SuperAdmin/Table/advancedFilters";

type Props = {
  children: React.ReactNode;
  title: string;
  titleSuffixComponent?: React.ReactNode;
  hasRecycleBin?: boolean;
  hasAddButton?: boolean;
  addButtonText?: string;
  addButtonPath?: string;
  hasFilterButton?: boolean;
  hasPagination?: boolean;
  apiUrl?: string;
  isRecycleBinOpen?: boolean;
  filterOptions?: AdvancedFilterField[];
  filters?: AdvancedFilterItem[];
  onFiltersChange?: (filters: AdvancedFilterItem[]) => void;
  recycleCount?: number;
  recycleCountError?: boolean;
  setIsRecycleBinOpen?: (isRecycleBinOpen: boolean) => void;
};

/**
 * One responsive page shell. This previously existed as three near-identical
 * viewport components (Desktop/Tablet/Mobile) selected by CSS wrappers, whose
 * only differences were class strings — and whose body/pagination blocks were
 * dead because the parent passed `renderBody: false`.
 */
export default function ContentWrapper({
  children,
  title,
  titleSuffixComponent,
  hasRecycleBin,
  hasAddButton,
  addButtonText,
  addButtonPath,
  hasFilterButton,
  hasPagination,
  apiUrl,
  isRecycleBinOpen,
  filterOptions,
  filters,
  onFiltersChange,
  recycleCount,
  recycleCountError,
  setIsRecycleBinOpen,
}: Props) {
  const [fetchedRecycleCount, setFetchedRecycleCount] = useState(0);
  const [fetchedRecycleCountError, setFetchedRecycleCountError] =
    useState(false);
  const [isFilterOpen, setFilterIsOpen] = useState(false);
  const [refresh] = useAtom(refreshTable);
  const hasExternalRecycleCount = recycleCount !== undefined;

  useEffect(() => {
    if (!hasRecycleBin || !apiUrl || hasExternalRecycleCount) return;

    let active = true;
    apiClient
      .get<{ id: number }[]>(`${apiUrl}?filters[removedAt][$null]=false`)
      .then((response) => {
        if (!active) return;
        setFetchedRecycleCount(response.meta?.pagination?.total ?? 0);
        setFetchedRecycleCountError(false);
      })
      .catch(() => {
        if (!active) return;
        setFetchedRecycleCount(0);
        setFetchedRecycleCountError(true);
      });

    return () => {
      active = false;
    };
  }, [hasExternalRecycleCount, apiUrl, hasRecycleBin, refresh]);

  const resolvedRecycleCount = recycleCount ?? fetchedRecycleCount;
  const resolvedRecycleCountError =
    recycleCountError ?? fetchedRecycleCountError;
  const showFilterButton = hasFilterButton && !!filterOptions?.length;
  const hasActions = hasRecycleBin || hasAddButton || showFilterButton;

  return (
    <AdvancedFilterFieldsProvider value={filterOptions ?? []}>
      <div className="w-full">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-4">
          <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center md:gap-3">
            <span className="min-w-0 break-words text-xl text-[#202224] md:text-2xl lg:text-3xl">
              {isRecycleBinOpen ? "زباله‌دان" : title}
            </span>
            {titleSuffixComponent}
          </div>

          {hasActions && (
            <div className="flex items-center gap-2 md:shrink-0 md:gap-3 [&>*]:min-w-0 [&>*]:flex-1 md:[&>*]:flex-none">
              {hasRecycleBin && (
                <RecycleBinButton
                  count={resolvedRecycleCount}
                  hasError={resolvedRecycleCountError}
                  isRecycleBinOpen={isRecycleBinOpen}
                  setIsRecycleBinOpen={setIsRecycleBinOpen}
                />
              )}

              {hasAddButton && (
                <AddButton
                  text={addButtonText ?? ""}
                  path={addButtonPath ?? "#"}
                />
              )}

              {showFilterButton && (
                <FilterButton
                  isFilterOpen={isFilterOpen}
                  setFilterIsOpen={setFilterIsOpen}
                  options={filterOptions ?? []}
                  filters={filters}
                  onFiltersChange={onFiltersChange}
                />
              )}
            </div>
          )}
        </div>

        {hasPagination && (
          <div className="mt-3 flex justify-end">
            <SuperAdminPageSizeSelect />
          </div>
        )}

        <div className="mt-4 md:card md:mt-3 md:p-5 lg:p-7">{children}</div>

        {hasPagination && (
          <div className="sticky bottom-0 z-30 mt-3 flex justify-end pb-[env(safe-area-inset-bottom)] lg:bottom-2 lg:mt-4 lg:justify-center">
            <div className="min-w-0 max-w-full rounded-xl border border-gray-200/70 bg-white/80 px-4 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:backdrop-blur lg:rounded-3xl lg:bg-slate-700/10 lg:backdrop-blur-2xl">
              <SuperAdminPagination />
            </div>
          </div>
        )}
      </div>
    </AdvancedFilterFieldsProvider>
  );
}
