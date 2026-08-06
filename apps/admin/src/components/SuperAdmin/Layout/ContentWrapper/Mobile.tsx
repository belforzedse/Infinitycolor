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
  apiUrl?: string;
  totalPages?: number;
  isRecycleBinOpen?: boolean;
  filterOptions?: AdvancedFilterField[];
  filters?: AdvancedFilterItem[];
  onFiltersChange?: (filters: AdvancedFilterItem[]) => void;
  recycleCount?: number;
  recycleCountError?: boolean;
  renderBody?: boolean;
  setIsRecycleBinOpen?: (isRecycleBinOpen: boolean) => void;
};

export default function SuperAdminLayoutContentWrapperMobile(props: Props) {
  const {
    children,
    title,
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
    titleSuffixComponent,
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
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="min-w-0 break-words text-3xl text-[#202224]">
            {isRecycleBinOpen ? "زباله‌دان" : title}
          </span>

          {hasRecycleBin && (
            <RecycleBinButton
              count={recycleCount}
              hasError={recycleCountError}
              isRecycleBinOpen={isRecycleBinOpen}
              setIsRecycleBinOpen={setIsRecycleBinOpen}
            />
          )}
        </div>

        <div className="w-full">{titleSuffixComponent}</div>

        <div className="flex items-center gap-2">
          {hasAddButton && (
            <div className="flex-1">
              <AddButton text={addButtonText ?? ""} path={addButtonPath} />
            </div>
          )}

          {hasFilterButton && !!filterOptions?.length && (
            <div className="flex-1">
              <FilterButton
                options={filterOptions || []}
                isFilterOpen={isFilterOpen}
                setFilterIsOpen={setFilterIsOpen}
                filters={filters}
                onFiltersChange={onFiltersChange}
              />
            </div>
          )}
        </div>
      </div>

      {hasPagination && (
        <div className="mt-3 flex justify-end">
          <SuperAdminPageSizeSelect />
        </div>
      )}

      {renderBody && <div className="mt-5">{children}</div>}
      {renderBody && hasPagination && (
        <div className="sticky bottom-0 z-30 mt-4 flex justify-end">
          <div className="rounded-xl border border-gray-200/70 bg-white/80 px-4 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:backdrop-blur">
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
