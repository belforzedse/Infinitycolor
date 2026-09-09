"use client";

import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import { MobileTable, columns, bulkPrintOrders, Order } from "./table";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { SubNav } from "@/components/admin";
import { useEffect, useState, useMemo, useCallback } from "react";
import { useQueryState } from "nuqs";
import { useDebouncedCallback } from "use-debounce";
import { useAtom } from "jotai";
import { refreshTable } from "@/components/SuperAdmin/Table";
import toast from "react-hot-toast";
import {
  cancelOrder,
  changeOrderStatus,
  OrderLifecycleStatus,
} from "@/services/super-admin/orders/adjustItems";
import { translateOrderStatus } from "@/utils/statusTranslations";
import { listAdminOrders } from "@/services/super-admin/orders/list";
import type { AdvancedFilterItem } from "@/components/SuperAdmin/Table/advancedFilters";
import { useCan } from "@/hooks/useCan";
import { useLegacyFilterQueryCleanup } from "@/hooks/useLegacyFilterQueryCleanup";

// Server-side category tabs. Buckets map to the real backend Status enum
// (Paying/Started/Shipment/Done/Returned/Cancelled); «سفارش‌های دستی» filters by
// the Manual order Type, so manual orders still appear in their status bucket too.
type OrderTab =
  | "all"
  | "paying"
  | "inprogress"
  | "completed"
  | "cancelled"
  | "manual";

const ORDER_TABS: { key: OrderTab; label: string }[] = [
  { key: "all", label: "همه" },
  { key: "paying", label: "در انتظار پرداخت" },
  { key: "inprogress", label: "در حال انجام" },
  { key: "completed", label: "تکمیل شده" },
  { key: "cancelled", label: "لغو شده یا ناموفق" },
  { key: "manual", label: "سفارش‌های دستی" },
];

// Fulfilment transitions only. Cancel is a separate bulk action that hits
// `/admin/cancel` (refund/restock) instead of the status-transition endpoint.
const BULK_STATUS_OPTIONS: { status: OrderLifecycleStatus; label: string }[] = [
  { status: "Started", label: "در حال انجام" },
  { status: "Done", label: "تکمیل شده" },
];

export default function OrdersPage() {
  const canCreateManualOrder = useCan("order.manual.create");
  // Bulk actions call the exact same per-order operations, so they must use
  // the same capabilities instead of requiring a second, unrelated bulk flag.
  const canChangeOrderStatus = useCan("order.status.update");
  const canCancelOrders = useCan("order.cancel");
  const canPrintOrders = useCan("order.read");
  const [, setRefresh] = useAtom(refreshTable);
  const [activeTab, setActiveTab] = useState<OrderTab>("all");
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedFilterItem[]>(
    [],
  );
  const [, setPage] = useQueryState("page", { defaultValue: "1" });
  useLegacyFilterQueryCleanup();

  const handleTabChange = useCallback(
    (tabKey: OrderTab) => {
      setActiveTab(tabKey);
      // Reset to the first page so a filtered result set never lands on an empty page.
      void setPage("1");
    },
    [setPage],
  );

  const [sort, setSort] = useState<"last-edited" | "newest" | "oldest">(
    "last-edited",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");

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

  const bulkOptions = useMemo(() => {
    const statusOptions = canChangeOrderStatus
      ? BULK_STATUS_OPTIONS.map(({ status, label }) => ({
          id: `status-${status}`,
          title: `تغییر وضعیت به «${label}»`,
        }))
      : [];
    return [
      ...(canPrintOrders ? [{ id: "print", title: "پرینت دسته‌ای" }] : []),
      ...statusOptions,
      ...(canCancelOrders ? [{ id: "cancel", title: "لغو سفارش" }] : []),
    ];
  }, [canCancelOrders, canChangeOrderStatus, canPrintOrders]);

  const handleBulkAction = useCallback(
    async (actionId: string, selectedRows: Order[]) => {
      if (actionId === "print") {
        if (!canPrintOrders) return;
        bulkPrintOrders(selectedRows.map((row) => row.id));
        return;
      }

      if (actionId === "cancel") {
        if (!canCancelOrders) return;
        const alreadyCancelled = selectedRows.filter(
          (row) => row.attributes.Status === "Cancelled",
        );
        const eligible = selectedRows.filter(
          (row) => row.attributes.Status !== "Cancelled",
        );

        if (eligible.length === 0) {
          toast.error("همه سفارش‌های انتخاب‌شده قبلاً لغو شده‌اند.");
          return;
        }

        try {
          await Promise.all(
            eligible.map((row) => cancelOrder(Number(row.id))),
          );
          toast.success(`${eligible.length} سفارش لغو شد.`);
          if (alreadyCancelled.length > 0) {
            toast(`${alreadyCancelled.length} سفارش از قبل لغو شده بود.`);
          }
          setRefresh(true);
        } catch (error) {
          console.error("Bulk order cancel error:", error);
          toast.error("لغو سفارش‌ها انجام نشد. دوباره تلاش کنید");
        }
        return;
      }

      if (actionId.startsWith("status-")) {
        if (!canChangeOrderStatus) return;
        const statusKey = actionId.replace(
          "status-",
          "",
        ) as OrderLifecycleStatus;

        // Held reserve orders are refused server-side (`RESERVE_HOLD_ACTIVE`)
        // for fulfilment transitions. Filtering them out here means a mixed
        // selection still succeeds for the rest instead of failing as a
        // partially-applied batch. Cancel is handled above and does not skip
        // held reserve orders.
        const held = selectedRows.filter((row) => row.attributes.reserveIsHeld);
        const eligible = selectedRows.filter((row) => !row.attributes.reserveIsHeld);

        if (eligible.length === 0) {
          toast.error(
            "همه سفارش‌های انتخاب‌شده در مهلت رزرو هستند و تا پایان مهلت ارسال نمی‌شوند.",
          );
          return;
        }

        try {
          await Promise.all(
            eligible.map((row) => changeOrderStatus(row.id, statusKey)),
          );
          toast.success(
            `${eligible.length} سفارش به وضعیت «${translateOrderStatus(statusKey)}» منتقل شد.`,
          );
          if (held.length > 0) {
            toast(
              `${held.length} سفارش به دلیل بودن در مهلت رزرو تغییر نکرد.`,
              { icon: "⏳" },
            );
          }
          setRefresh(true);
        } catch (error) {
          console.error("Bulk order status update error:", error);
          toast.error("خطا در بروزرسانی وضعیت سفارش‌ها. دوباره تلاش کنید");
        }
      }
    },
    [canCancelOrders, canChangeOrderStatus, canPrintOrders, setRefresh],
  );

  const loadOrders = useCallback(
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
      listAdminOrders({
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

  const handleFiltersChange = useCallback(
    (next: AdvancedFilterItem[]) => {
      setAdvancedFilters(next);
      void setPage("1");
    },
    [setPage],
  );

  return (
    <ContentWrapper
      title="سفارشات"
      filterOptions={[
        { id: "[id]", title: "شماره سفارش", type: "number" },
        { id: "[contract][Amount]", title: "مبلغ", type: "number" },
        {
          id: "[contract][external_id]",
          title: "ایدی تراکنش",
          type: "text",
        },
        { id: "[Description]", title: "توضیحات", type: "text" },
        { id: "[user][user_info][FirstName]", title: "نام", type: "text" },
        {
          id: "[user][user_info][LastName]",
          title: "نام خانوادگی",
          type: "text",
        },
        { id: "[user][phone]", title: "شماره تلفن", type: "text" },
        { id: "[createdAt]", title: "تاریخ ایجاد", type: "date" },
      ]}
      hasAddButton={canCreateManualOrder}
      addButtonText="افزودن سفارش جدید"
      addButtonPath="/orders/add"
      hasFilterButton
      hasPagination
      filters={advancedFilters}
      onFiltersChange={handleFiltersChange}
    >
      {/* Shared tab pattern: scrolls horizontally on phones instead of wrapping
          to three rows, and every tab clears a 44px touch target. */}
      <SubNav
        className="mb-3"
        ariaLabel="وضعیت سفارش‌ها"
        items={ORDER_TABS.map((tab) => ({ id: tab.key, label: tab.label }))}
        activeId={activeTab}
        onSelect={(id) => handleTabChange(id as OrderTab)}
      />
      <div className="mb-3 flex flex-col gap-3 rounded-2xl bg-white/70 p-3 md:flex-row md:flex-wrap md:items-center md:bg-transparent md:p-0">
        <div className="flex w-full flex-col gap-1.5 sm:w-auto sm:flex-row sm:items-center sm:gap-2">
          <label className="text-sm text-neutral-600">مرتب‌سازی:</label>
          <select
            className="h-10 w-full rounded-lg border border-neutral-300 px-3 py-1 text-sm sm:w-auto sm:min-w-40"
            value={sort}
            onChange={(e) =>
              setSort(e.target.value as "last-edited" | "newest" | "oldest")
            }
          >
            <option value="last-edited">آخرین ویرایش</option>
            <option value="newest">جدیدترین</option>
            <option value="oldest">قدیمی‌ترین</option>
          </select>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
          <label className="text-sm text-neutral-600">
            جستجو:
          </label>
          <div className="relative w-full sm:w-80">
            <input
              type="text"
              placeholder="شماره سفارش، نام مشتری، تلفن، کد رهگیری..."
              className="h-10 w-full rounded-lg border border-neutral-300 px-3 py-1 pr-8 text-sm"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              inputMode="search"
              enterKeyHint="search"
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
              className="self-start text-sm text-neutral-500 hover:text-neutral-700 sm:self-auto"
            >
              پاک کردن
            </button>
          )}
          {debouncedSearchQuery && (
            <span className="break-words text-xs text-green-600">
              نتایج برای: &quot;{debouncedSearchQuery}&quot;
            </span>
          )}
        </div>
      </div>
      <SuperAdminTable
        columns={columns}
        enableSelection={bulkOptions.length > 0}
        bulkOptions={bulkOptions}
        onBulkAction={handleBulkAction}
        filters={advancedFilters}
        dataLoader={loadOrders}
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
          handleFiltersChange([]);
        }}
        // `selectionProps` must be threaded through: without it the mobile rows
        // rendered an uncontrolled checkbox, so bulk print and bulk status
        // changes silently operated on zero orders.
        mobileTable={(data, selectionProps) => (
          <MobileTable data={data} selectionProps={selectionProps} />
        )}
      />
    </ContentWrapper>
  );
}
