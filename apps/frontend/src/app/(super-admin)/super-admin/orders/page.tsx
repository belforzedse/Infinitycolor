"use client";

import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import { MobileTable, columns, bulkPrintOrders, Order } from "./table";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { useEffect, useState, useMemo, useCallback } from "react";
import { useQueryState } from "nuqs";
import { useDebouncedCallback } from "use-debounce";
import { useFreshDataOnPageLoad } from "@/hooks/useFreshDataOnPageLoad";
import { useAtom } from "jotai";
import { refreshTable } from "@/components/SuperAdmin/Table";
import toast from "react-hot-toast";
import {
  changeOrderStatus,
  ORDER_STATUS_LABELS,
  ORDER_STATUSES,
  OrderLifecycleStatus,
} from "@/services/super-admin/orders/adjustItems";

// Server-side category tabs. Buckets map to the real backend Status enum
// (Paying/Started/Shipment/Done/Returned/Cancelled); «سفارش‌های دستی» filters by
// the Manual order Type, so manual orders still appear in their status bucket too.
const ORDER_TABS: { key: string; label: string; filter: string }[] = [
  { key: "all", label: "همه", filter: "" },
  {
    key: "inprogress",
    label: "در حال انجام",
    filter:
      "&filters[Status][$in][0]=Paying&filters[Status][$in][1]=Started&filters[Status][$in][2]=Shipment",
  },
  { key: "completed", label: "تکمیل شده", filter: "&filters[Status][$eq]=Done" },
  {
    key: "cancelled",
    label: "لغو شده یا ناموفق",
    filter: "&filters[Status][$in][0]=Returned&filters[Status][$in][1]=Cancelled",
  },
  { key: "manual", label: "سفارش‌های دستی", filter: "&filters[Type][$eq]=Manual" },
];

export default function OrdersPage() {
  useFreshDataOnPageLoad();
  const [, setRefresh] = useAtom(refreshTable);
  const [activeTab, setActiveTab] = useState("all");
  const [, setPage] = useQueryState("page", { defaultValue: "1" });

  const handleTabChange = useCallback(
    (tabKey: string) => {
      setActiveTab(tabKey);
      // Reset to the first page so a filtered result set never lands on an empty page.
      void setPage("1");
    },
    [setPage],
  );

  const tabFilter = useMemo(
    () => ORDER_TABS.find((tab) => tab.key === activeTab)?.filter ?? "",
    [activeTab],
  );
  const [sort, setSort] = useState<"last-edited" | "newest" | "oldest">("last-edited");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");

  // Debounce search input to avoid excessive API calls
  const debouncedSearch = useDebouncedCallback((query: string) => {
    setDebouncedSearchQuery(query);
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
    const statusOptions = ORDER_STATUSES.map((status) => ({
      id: `status-${status}`,
      title: `وضعیت ${ORDER_STATUS_LABELS[status]}`,
    }));

    return [{ id: "print", title: "پرینت دسته‌ای" }, ...statusOptions];
  }, []);

  const handleBulkAction = useCallback(
    async (actionId: string, selectedRows: Order[]) => {
      if (actionId === "print") {
        bulkPrintOrders(selectedRows.map((row) => row.id));
        return;
      }

      if (actionId.startsWith("status-")) {
        const statusKey = actionId.replace("status-", "") as OrderLifecycleStatus;
        try {
          await Promise.all(selectedRows.map((row) => changeOrderStatus(row.id, statusKey)));
          toast.success(
            `${selectedRows.length} سفارش به وضعیت ${ORDER_STATUS_LABELS[statusKey]} منتقل شد.`,
          );
          setRefresh(true);
        } catch (error) {
          console.error("Bulk order status update error:", error);
          toast.error("خطا در بروزرسانی وضعیت سفارش‌ها");
        }
      }
    },
    [setRefresh],
  );

  return (
    <ContentWrapper
      title="سفارشات"
      filterOptions={[
        { id: "[id]", title: "شماره سفارش", type: "number" },
        {
          id: "[Status]",
          title: "وضعیت سفارش",
          type: "select",
          options: ORDER_STATUSES.map((status) => ({
            id: status,
            title: ORDER_STATUS_LABELS[status],
          })),
        },
        { id: "[contract][Amount]", title: "مبلغ", type: "number" },
        {
          id: "[contract][external_id]",
          title: "ایدی تراکنش اسنپ پی",
          type: "text",
        },
        { id: "[Description]", title: "توضیحات", type: "text" },
        { id: "[user][user_info][FirstName]", title: "نام", type: "text" },
        { id: "[user][user_info][LastName]", title: "نام خانوادگی", type: "text" },
        { id: "[user][phone]", title: "شماره تلفن", type: "text" },
        { id: "[createdAt]", title: "تاریخ ایجاد", type: "date" },
      ]}
      hasAddButton
      addButtonText="افزودن سفارش جدید"
      addButtonPath="/super-admin/orders/add"
      hasFilterButton
      hasPagination
    >
      <div className="mb-3 flex flex-wrap gap-2" dir="rtl">
        {ORDER_TABS.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => handleTabChange(tab.key)}
              className={
                isActive
                  ? "rounded-lg bg-actions-primary px-4 py-2 text-sm font-medium text-white"
                  : "rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-50"
              }
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div className="mb-3 flex flex-col gap-3 rounded-2xl bg-white/70 p-3 md:flex-row md:flex-wrap md:items-center md:bg-transparent md:p-0">
        <div className="flex w-full flex-col gap-1.5 sm:w-auto sm:flex-row sm:items-center sm:gap-2">
          <label className="text-sm text-neutral-600">مرتب‌سازی:</label>
          <select
            className="h-10 w-full rounded-lg border border-neutral-300 px-3 py-1 text-sm sm:w-auto sm:min-w-40"
            value={sort}
            onChange={(e) => setSort(e.target.value as "last-edited" | "newest" | "oldest")}
          >
            <option value="last-edited">آخرین ویرایش</option>
            <option value="newest">جدیدترین</option>
            <option value="oldest">قدیمی‌ترین</option>
          </select>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
          <label className="text-sm text-neutral-600">جستجوی ایدی تراکنش اسنپ پی:</label>
          <div className="relative w-full sm:w-80">
            <input
              type="text"
              placeholder="جستجوی ایدی تراکنش اسنپ پی ..."
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
        _removeActions
        columns={columns}
        enableSelection
        bulkOptions={bulkOptions}
        onBulkAction={handleBulkAction}
        url={(() => {
          const sortQuery =
            sort === "last-edited"
              ? "updatedAt:desc"
              : sort === "newest"
                ? "createdAt:desc"
                : "createdAt:asc";
          const base = `/orders?sort[0]=${sortQuery}&populate[0]=user&populate[1]=contract&populate[2]=user.user_info&populate[3]=contract${tabFilter}`;

          if (debouncedSearchQuery.trim()) {
            return (
              base +
              `&filters[contract][external_id][$containsi]=${encodeURIComponent(debouncedSearchQuery.trim())}`
            );
          }

          return base;
        })()}
        mobileTable={(data) => <MobileTable data={data} />}
      />
    </ContentWrapper>
  );
}
