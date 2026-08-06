"use client";

import Desktop from "./Desktop";
import Mobile from "./Mobile";
import Tablet from "./Tablet";
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { apiClient } from "@/services";
import { refreshTable } from "@/components/SuperAdmin/Table";
import SuperAdminPagination from "../../Pagination";
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
  totalPages?: number;
  isRecycleBinOpen?: boolean;
  filterOptions?: AdvancedFilterField[];
  filters?: AdvancedFilterItem[];
  onFiltersChange?: (filters: AdvancedFilterItem[]) => void;
  recycleCount?: number;
  recycleCountError?: boolean;
  setIsRecycleBinOpen?: (isRecycleBinOpen: boolean) => void;
};

export default function ContentWrapper(props: Props) {
  const [fetchedRecycleCount, setFetchedRecycleCount] = useState(0);
  const [fetchedRecycleCountError, setFetchedRecycleCountError] =
    useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [refresh] = useAtom(refreshTable);
  const hasExternalRecycleCount = props.recycleCount !== undefined;

  useEffect(() => {
    if (!props.hasRecycleBin || !props.apiUrl || hasExternalRecycleCount)
      return;

    let active = true;
    apiClient
      .get<{ id: number }[]>(`${props.apiUrl}?filters[removedAt][$null]=false`)
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
  }, [hasExternalRecycleCount, props.apiUrl, props.hasRecycleBin, refresh]);

  const sharedProps = {
    ...props,
    recycleCount: props.recycleCount ?? fetchedRecycleCount,
    recycleCountError: props.recycleCountError ?? fetchedRecycleCountError,
    renderBody: false,
  };

  return (
    <AdvancedFilterFieldsProvider value={props.filterOptions ?? []}>
      <div className="w-full">
        <div className="block md:hidden">
          <Mobile {...sharedProps} />
        </div>
        <div className="hidden md:block lg:hidden">
          <Tablet {...sharedProps} />
        </div>
        <div className="hidden lg:block">
          <Desktop {...sharedProps} />
        </div>

        <div className="mt-5 md:card md:mt-2 md:p-4 lg:mt-3 lg:p-7">
          {props.children}
        </div>

        {props.hasPagination && (
          <div className="sticky bottom-0 z-30 mt-3 flex justify-end lg:bottom-2 lg:mt-4 lg:justify-center">
            <div className="rounded-xl border border-gray-200/70 bg-white/80 px-4 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:backdrop-blur lg:rounded-3xl lg:bg-slate-700/10 lg:backdrop-blur-2xl">
              <SuperAdminPagination
                currentPage={currentPage}
                totalPages={props.totalPages ?? 1}
                onPageChange={setCurrentPage}
              />
            </div>
          </div>
        )}
      </div>
    </AdvancedFilterFieldsProvider>
  );
}
