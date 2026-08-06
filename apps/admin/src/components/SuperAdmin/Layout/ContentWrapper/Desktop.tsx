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

export default function SuperAdminLayoutContentWrapperDesktop(props: Props) {
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
        <div className="flex items-center gap-3">
          <span className="text-2xl text-[#202224] lg:text-3xl">
            {isRecycleBinOpen ? "زباله‌دان" : title}
          </span>

          {titleSuffixComponent}
        </div>

        <div className="flex items-center gap-2 lg:gap-3">
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
        <div className="mt-3 flex justify-end">
          <SuperAdminPageSizeSelect />
        </div>
      )}
      {renderBody && (
        <div className="card mt-3 p-4 md:p-5 lg:p-7">{children}</div>
      )}
      {renderBody && hasPagination && (
        <div className="sticky bottom-2 z-30 mt-4 flex justify-center">
          <div className="rounded-3xl border border-gray-200/70 bg-slate-700/10 px-4 py-3 shadow-sm backdrop-blur-2xl supports-[backdrop-filter]:backdrop-blur-lg">
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
