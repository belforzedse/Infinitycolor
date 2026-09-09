"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryState } from "nuqs";
import { useDebouncedCallback } from "use-debounce";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import { SubNav } from "@/components/admin";
import type { AdvancedFilterItem } from "@/components/SuperAdmin/Table/advancedFilters";
import {
  listAdminReserveGroups,
  type ReserveGroupSort,
  type ReserveGroupTab,
} from "@/services/super-admin/orders/reserveGroups";
import { reserveGroupColumns, ReserveGroupsMobileTable } from "./table";

/**
 * Reserve shipments as an operations view.
 *
 * Rows are groups, not orders: a combined shipment is picked, printed and
 * dispatched once even though it settles several independent orders, so the
 * unit of work here has to be the group. Segments map to real lifecycle states
 * except «رو به اتمام», which is derived from the deadline server-side.
 */
const RESERVE_TABS: { key: ReserveGroupTab; label: string }[] = [
  { key: "all", label: "همه" },
  { key: "active", label: "فعال" },
  { key: "ending_soon", label: "رو به اتمام" },
  { key: "ready", label: "آماده ارسال" },
  { key: "fulfilling", label: "در حال ارسال" },
  { key: "completed", label: "تکمیل‌شده" },
];

export default function ReserveGroupsPage() {
  const [activeTab, setActiveTab] = useState<ReserveGroupTab>("active");
  const [sort, setSort] = useState<ReserveGroupSort>("deadline");
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedFilterItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [, setPage] = useQueryState("page", { defaultValue: "1" });

  const debouncedSearch = useDebouncedCallback((query: string) => {
    setDebouncedSearchQuery(query);
    void setPage("1");
  }, 500);

  useEffect(() => {
    debouncedSearch(searchQuery);
  }, [searchQuery, debouncedSearch]);

  useEffect(() => () => debouncedSearch.cancel(), [debouncedSearch]);

  const handleTabChange = useCallback(
    (tabKey: ReserveGroupTab) => {
      setActiveTab(tabKey);
      void setPage("1");
    },
    [setPage],
  );

  const loadGroups = useCallback(
    ({
      page,
      pageSize,
      filters,
      signal,
    }: {
      page: number;
      pageSize: number;
      filters: AdvancedFilterItem[];
      signal: AbortSignal;
    }) =>
      listAdminReserveGroups({
        page,
        pageSize,
        filters,
        signal,
        tab: activeTab,
        sort,
        search: debouncedSearchQuery,
      }),
    [activeTab, debouncedSearchQuery, sort],
  );

  return (
    <ContentWrapper
      title="سفارش‌های رزروی"
      hasPagination
      filters={advancedFilters}
      onFiltersChange={setAdvancedFilters}
    >
      <SubNav
        className="mb-3"
        ariaLabel="وضعیت بسته‌های رزروی"
        items={RESERVE_TABS.map((tab) => ({ id: tab.key, label: tab.label }))}
        activeId={activeTab}
        onSelect={(id) => handleTabChange(id as ReserveGroupTab)}
      />

      <div className="mb-3 flex flex-col gap-3 rounded-2xl bg-white/70 p-3 md:flex-row md:flex-wrap md:items-center md:bg-transparent md:p-0">
        <div className="flex w-full flex-col gap-1.5 sm:w-auto sm:flex-row sm:items-center sm:gap-2">
          <label className="text-sm text-neutral-600">مرتب‌سازی:</label>
          <select
            className="h-10 w-full rounded-lg border border-neutral-300 px-3 py-1 text-sm sm:w-auto sm:min-w-40"
            value={sort}
            onChange={(e) => setSort(e.target.value as ReserveGroupSort)}
          >
            <option value="deadline">نزدیک‌ترین پایان مهلت</option>
            <option value="last-activity">آخرین فعالیت</option>
            <option value="newest">جدیدترین</option>
            <option value="oldest">قدیمی‌ترین</option>
          </select>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
          <label className="text-sm text-neutral-600">جستجو:</label>
          <div className="relative w-full sm:w-80">
            <input
              type="text"
              placeholder="شناسه بسته، شماره سفارش، نام مشتری، تلفن..."
              className="h-10 w-full rounded-lg border border-neutral-300 px-3 py-1 pr-8 text-sm"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              inputMode="search"
              enterKeyHint="search"
            />
          </div>
          {searchQuery && (
            <button
              onClick={() => {
                setSearchQuery("");
                setDebouncedSearchQuery("");
              }}
              className="self-start text-sm text-neutral-500 hover:text-neutral-700 sm:self-auto"
            >
              پاک کردن
            </button>
          )}
        </div>
      </div>

      <SuperAdminTable
        columns={reserveGroupColumns}
        className="min-w-max [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap"
        filters={advancedFilters}
        dataLoader={loadGroups}
        dataLoaderKey={JSON.stringify({
          tab: activeTab,
          sort,
          search: debouncedSearchQuery,
        })}
        refreshOnVisibility={false}
        isFiltered={Boolean(debouncedSearchQuery) || advancedFilters.length > 0}
        onClearFilters={() => {
          setSearchQuery("");
          setDebouncedSearchQuery("");
          setAdvancedFilters([]);
        }}
        mobileTable={(data) => <ReserveGroupsMobileTable data={data} />}
      />
    </ContentWrapper>
  );
}
