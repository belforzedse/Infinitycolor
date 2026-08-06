"use client";

import { useState } from "react";
import SuperAdminPagination from "../../Pagination";
import SuperAdminPageSizeSelect from "../../Pagination/PageSizeSelect";
import RecycleBinButton from "./Button/RecycleBin";
import AddButton from "./Button/Add";
import FilterButton from "./Button/Filter";
import type {
  AdvancedFilterField,
  AdvancedFilterItem,
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
  totalPages?: number;
  apiUrl?: string;
  isRecycleBinOpen?: boolean;
  setIsRecycleBinOpen?: (isRecycleBinOpen: boolean) => void;
  filterOptions?: AdvancedFilterField[];
  filters?: AdvancedFilterItem[];
  onFiltersChange?: (filters: AdvancedFilterItem[]) => void;
  recycleCount?: number;
  recycleCountError?: boolean;
  renderBody?: boolean;
};

export default function SuperAdminLayoutContentWrapperTablet(props: Props) {
  const {
    children,
    title,
    titleSuffixComponent,
    hasRecycleBin,
    hasAddButton,
    addButtonText,
    addButtonPath,
    hasFilterButton,
    hasPagination,
    totalPages,
    isRecycleBinOpen,
    setIsRecycleBinOpen,
    filterOptions,
    filters,
    onFiltersChange,
    recycleCount = 0,
    recycleCountError = false,
    renderBody = true,
  } = props;

  const [currentPage, setCurrentPage] = useState(1);
  const [isFilterOpen, setFilterIsOpen] = useState(false);

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl text-[#202224]">
            {isRecycleBinOpen ? "زباله‌دان" : title}
          </span>

          {titleSuffixComponent}
        </div>

        <div className="flex items-center gap-2">
          {hasRecycleBin && (
            <RecycleBinButton
              count={recycleCount}
              hasError={recycleCountError}
              isRecycleBinOpen={isRecycleBinOpen}
              setIsRecycleBinOpen={setIsRecycleBinOpen}
            />
          )}

          {hasAddButton && (
            <AddButton text={addButtonText ?? ""} path={addButtonPath ?? "#"} />
          )}

          {hasFilterButton && !!filterOptions?.length && (
            <FilterButton
              isFilterOpen={isFilterOpen}
              setFilterIsOpen={setFilterIsOpen}
              options={filterOptions || []}
              filters={filters}
              onFiltersChange={onFiltersChange}
            />
          )}
        </div>
      </div>
      {hasPagination && (
        <div className="mt-2 flex justify-end">
          <SuperAdminPageSizeSelect />
        </div>
      )}
      {renderBody && <div className="card mt-2 p-4">{children}</div>}
      {renderBody && hasPagination && (
        <div className="sticky bottom-0 z-30 mt-3 flex justify-end">
          <div className="rounded-xl border border-gray-200/70 bg-white/80 px-4 py-3 shadow-sm backdrop-blur-xl supports-[backdrop-filter]:backdrop-blur">
            <SuperAdminPagination
              currentPage={currentPage}
              totalPages={totalPages ?? 1}
              onPageChange={handlePageChange}
            />
          </div>
        </div>
      )}
    </>
  );
}
