"use client";

import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import { columns, MobileTable } from "./table";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import {
  parseAdvancedFiltersParam,
  serializeAdvancedFiltersParam,
  type AdvancedFilterItem,
} from "@/components/SuperAdmin/Table/advancedFilters";
import { useCallback, useEffect, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import {
  listAdminUsers,
  type AdminUsersListMeta,
} from "@/services/super-admin/users/list";
import { useQueryState } from "nuqs";

export default function UsersPage() {
  const [isRecycleBinOpen, setIsRecycleBinOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [managerRolesOnly, setManagerRolesOnly] = useState(false);
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedFilterItem[]>(
    [],
  );
  const [recycleCount, setRecycleCount] = useState(0);
  const [recycleCountError, setRecycleCountError] = useState(false);
  const [, setPage] = useQueryState("page", { defaultValue: "1" });
  const [, setLegacyUrlFilters] = useQueryState<AdvancedFilterItem[]>(
    "filter",
    {
      defaultValue: [],
      parse: parseAdvancedFiltersParam,
      serialize: serializeAdvancedFiltersParam,
    },
  );

  useEffect(() => {
    // Older builds stored names/phones in the URL. The bounded contract keeps
    // filters in component state and the POST body, so remove any legacy query.
    void setLegacyUrlFilters(null);
  }, [setLegacyUrlFilters]);

  // Debounce search input to avoid excessive API calls
  const debouncedSearch = useDebouncedCallback((query: string) => {
    setDebouncedSearchQuery(query);
    void setPage("1");
  }, 500);

  // Trigger debounced search when searchQuery changes
  useEffect(() => {
    debouncedSearch(searchQuery);
  }, [searchQuery, debouncedSearch]);

  // Cancel any pending debounced calls on unmount
  useEffect(() => {
    return () => {
      debouncedSearch.cancel();
    };
  }, [debouncedSearch]);

  const loadUsers = useCallback(
    async ({
      page,
      pageSize,
      filters,
      signal,
    }: {
      page: number;
      pageSize: number;
      filters: AdvancedFilterItem[];
      signal: AbortSignal;
    }) => {
      try {
        const response = await listAdminUsers({
          page,
          pageSize,
          filters,
          signal,
          removed: isRecycleBinOpen,
          search: debouncedSearchQuery,
          managerRolesOnly,
          sort: { field: "id", direction: "desc" },
        });
        setRecycleCountError(false);
        return response;
      } catch (error) {
        if (!signal.aborted) {
          setRecycleCountError(true);
        }
        throw error;
      }
    },
    [debouncedSearchQuery, isRecycleBinOpen, managerRolesOnly],
  );

  const handleMetaChange = useCallback((meta: Partial<AdminUsersListMeta>) => {
    if (typeof meta.recycleCount === "number") {
      setRecycleCount(meta.recycleCount);
      setRecycleCountError(false);
    }
  }, []);

  const handleRecycleBinChange = useCallback(
    (next: boolean) => {
      setIsRecycleBinOpen(next);
      void setPage("1");
    },
    [setPage],
  );

  const handleFiltersChange = useCallback(
    (next: AdvancedFilterItem[]) => {
      setAdvancedFilters(next);
      void setPage("1");
    },
    [setPage],
  );

  return (
    <ContentWrapper
      title="کاربران"
      hasFilterButton
      hasRecycleBin
      hasPagination
      hasAddButton
      addButtonText="کاربر جدید"
      addButtonPath="/users/add"
      isRecycleBinOpen={isRecycleBinOpen}
      setIsRecycleBinOpen={handleRecycleBinChange}
      filters={advancedFilters}
      onFiltersChange={handleFiltersChange}
      recycleCount={recycleCount}
      recycleCountError={recycleCountError}
      filterOptions={[
        {
          id: "[user_info][FirstName]",
          title: "نام",
          type: "text",
        },
        {
          id: "[user_info][LastName]",
          title: "نام خانوادگی",
          type: "text",
        },
        {
          id: "[phone]",
          title: "شماره تلفن",
          type: "text",
        },
        {
          id: "[blocked]",
          title: "مسدود شده",
          type: "boolean",
        },
        {
          id: "[confirmed]",
          title: "تأیید شده",
          type: "boolean",
        },
      ]}
    >
      {/* This toolbar previously had no responsive classes at all: a fixed
          w-80 input inside a non-wrapping flex row, which overflowed on every
          phone. Mirrors the Products toolbar treatment. */}
      <div className="mb-3 space-y-3 rounded-2xl bg-white/70 p-3 md:bg-transparent md:p-0">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <label className="text-sm text-neutral-600" htmlFor="users-search">
            جستجو:
          </label>
          <div className="relative w-full sm:w-80">
            <input
              id="users-search"
              type="text"
              placeholder="جستجو در نام، نام خانوادگی، شماره تلفن..."
              className="text-sm h-11 w-full rounded-lg border border-neutral-300 px-3 pr-8 md:h-10"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              inputMode="search"
              enterKeyHint="search"
              autoCorrect="off"
              spellCheck={false}
            />
            {searchQuery !== debouncedSearchQuery && (
              <div className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2">
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"></div>
              </div>
            )}
          </div>
          {searchQuery && (
            <button
              onClick={() => {
                setSearchQuery("");
                setDebouncedSearchQuery("");
              }}
              className="text-sm self-start text-neutral-500 hover:text-neutral-700 sm:self-auto"
            >
              پاک کردن
            </button>
          )}
          {debouncedSearchQuery && (
            <span className="text-xs break-words text-green-600">
              نتایج برای: &quot;{debouncedSearchQuery}&quot;
            </span>
          )}
        </div>
        <label className="text-sm flex w-fit min-h-[44px] cursor-pointer items-center gap-2 text-neutral-600 md:min-h-0">
          <input
            type="checkbox"
            className="h-5 w-5 rounded border-slate-300 accent-infinity-primary"
            checked={managerRolesOnly}
            onChange={(e) => {
              setManagerRolesOnly(e.target.checked);
              void setPage("1");
            }}
          />
          فقط نقش‌های مدیریتی
        </label>
      </div>
      <SuperAdminTable
        columns={columns}
        filters={advancedFilters}
        dataLoader={loadUsers}
        dataLoaderKey={JSON.stringify({
          removed: isRecycleBinOpen,
          search: debouncedSearchQuery,
          managerRolesOnly,
        })}
        refreshOnVisibility={false}
        onMetaChange={handleMetaChange}
        isFiltered={
          Boolean(debouncedSearchQuery) ||
          managerRolesOnly ||
          advancedFilters.length > 0
        }
        onClearFilters={() => {
          setSearchQuery("");
          setDebouncedSearchQuery("");
          setManagerRolesOnly(false);
          handleFiltersChange([]);
        }}
        mobileTable={(data) => <MobileTable data={data} />}
      />
    </ContentWrapper>
  );
}
