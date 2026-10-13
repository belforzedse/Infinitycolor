"use client";

import { useCallback, useMemo, useState } from "react";
import { useSetAtom } from "jotai";
import toast from "react-hot-toast";
import { Trash2 } from "lucide-react";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { SuperAdminTable, refreshTable } from "@/components/SuperAdmin/Table";
import { EmptyState, FilteredEmptyState, SubNav } from "@/components/admin";
import type {
  AdvancedFilterField,
  AdvancedFilterItem,
} from "@/components/SuperAdmin/Table/advancedFilters";
import type {
  BulkActionContext,
  BulkActionOption,
} from "@/components/SuperAdmin/Table/bulkActions";
import { useCan } from "@/hooks/useCan";
import { useLegacyFilterQueryCleanup } from "@/hooks/useLegacyFilterQueryCleanup";
import { updateBulkProductStock } from "@/services/super-admin/product/bulk-stock";
import { faNum } from "@/utils/faNum";
import { listAdminProducts } from "@/services/super-admin/product/list";
import PermanentDeleteDialog from "./PermanentDeleteDialog";
import ProductListToolbar from "./ProductListToolbar";
import ProductMobileList from "./ProductMobileList";
import ProductRowActions from "./ProductRowActions";
import ScheduleProductsDialog from "./ScheduleProductsDialog";
import { buildProductColumns } from "./productColumns";
import {
  bulkActionsFor,
  PRODUCT_VIEW_TABS,
  VIEW_EMPTY_STATE,
  type ProductBulkActionId,
  type ProductLifecycleCapabilities,
  type ProductRowActionId,
} from "./productLifecycle";
import type { AdminProductRow } from "./types";
import { useProductLifecycleActions } from "./useProductLifecycleActions";
import { useProductLifecycleCounts } from "./useProductLifecycleCounts";
import { useProductListQueryState } from "./useProductListQueryState";

/**
 * Advanced filters beyond the quick ones in the toolbar. Publication status is
 * not here: the lifecycle tabs are the status filter.
 */
export const PRODUCT_FILTER_OPTIONS: AdvancedFilterField[] = [
  { id: "[Title]", title: "نام محصول", type: "text" },
  { id: "[Slug]", title: "نامک", type: "text" },
  {
    id: "[product_main_category][Title]",
    title: "نام دسته‌بندی اصلی",
    type: "text",
  },
  { id: "[product_variations][SKU]", title: "SKU", type: "text" },
  { id: "[product_variations][Price]", title: "قیمت", type: "number" },
  {
    id: "[product_variations][DiscountPrice]",
    title: "قیمت تخفیف",
    type: "number",
  },
  {
    id: "[product_variations][product_stock][Count]",
    title: "موجودی تنوع",
    type: "number",
  },
  { id: "[createdAt]", title: "تاریخ ایجاد", type: "date" },
  { id: "[PublishedAt]", title: "تاریخ اولین انتشار", type: "date" },
  {
    id: "[scheduledPublishAt]",
    title: "تاریخ انتشار زمان‌بندی‌شده",
    type: "date",
  },
  { id: "[LastEditedByAdminAt]", title: "آخرین ویرایش", type: "date" },
];

const BULK_TITLES: Record<ProductBulkActionId, string> = {
  publish: "انتشار",
  unpublish: "بازگشت به پیش‌نویس",
  schedule: "زمان‌بندی انتشار",
  trash: "انتقال به سطل زباله",
  restore: "بازیابی به پیش‌نویس",
  purge: "حذف دائمی",
  set_stock: "تنظیم موجودی",
  remove_stock: "صفر کردن موجودی",
};

type ScheduleRequest = {
  rows: AdminProductRow[];
  currentPublishAt?: string | null;
};
type PurgeRequest =
  | { rows: AdminProductRow[] }
  | { emptyTrash: true; count: number };

export default function ProductsLifecycleView() {
  useLegacyFilterQueryCleanup();
  const list = useProductListQueryState();
  const setRefresh = useSetAtom(refreshTable);

  const canCreate = useCan("product.create");
  const canPublish = useCan("product.publish");
  const canSchedule = useCan("product.schedule");
  const canSoftDelete = useCan("product.softDelete");
  const canRestore = useCan("product.restore");
  const canDelete = useCan("product.delete");
  const canDuplicate = useCan("product.duplicate");
  const canUpdateStock = useCan("product.stock.update");
  const can = useMemo<ProductLifecycleCapabilities>(
    () => ({
      publish: canPublish,
      schedule: canSchedule,
      softDelete: canSoftDelete,
      restore: canRestore,
      delete: canDelete,
      duplicate: canDuplicate,
      stock: canUpdateStock,
    }),
    [
      canDelete,
      canDuplicate,
      canPublish,
      canRestore,
      canSchedule,
      canSoftDelete,
      canUpdateStock,
    ],
  );

  const counts = useProductLifecycleCounts(list.criteria);
  const refreshAll = useCallback(() => setRefresh(true), [setRefresh]);
  const actions = useProductLifecycleActions({ onChanged: refreshAll });

  const [scheduleRequest, setScheduleRequest] =
    useState<ScheduleRequest | null>(null);
  const [purgeRequest, setPurgeRequest] = useState<PurgeRequest | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  // What the admin was looking at when they chose Empty Trash: nothing trashed
  // after this moment is swept up unseen.
  const [trashLoadedAt, setTrashLoadedAt] = useState<string | null>(null);
  const [trashRetentionDays, setTrashRetentionDays] = useState<number | null>(
    null,
  );

  const retentionDays = trashRetentionDays ?? counts.trashRetentionDays ?? 0;

  const onRowAction = useCallback(
    (action: ProductRowActionId, row: AdminProductRow) => {
      switch (action) {
        case "preview":
          return void actions.preview(row);
        case "duplicate":
          return void actions.duplicate(row);
        case "publish":
          return void actions.setPublication(row, "publish-now");
        case "unpublish":
          return void actions.setPublication(row, "unpublish");
        case "schedule":
        case "reschedule":
          return setScheduleRequest({
            rows: [row],
            currentPublishAt: row.attributes.scheduledPublishAt,
          });
        case "trash":
          return void actions.trash(row);
        case "restore":
          return void actions.restore(row);
        case "purge":
          return setPurgeRequest({ rows: [row] });
        default:
          return undefined;
      }
    },
    [actions],
  );

  const renderActions = useCallback(
    (row: AdminProductRow) => (
      <ProductRowActions row={row} can={can} onAction={onRowAction} />
    ),
    [can, onRowAction],
  );

  const columns = useMemo(
    () =>
      buildProductColumns({
        view: list.view,
        showRetention: retentionDays > 0,
        renderActions,
      }),
    [list.view, renderActions, retentionDays],
  );

  const bulkOptions = useMemo<BulkActionOption[]>(() => {
    const ids = bulkActionsFor(list.view, can);
    return ids.map((id): BulkActionOption => {
      const base = { id, title: BULK_TITLES[id] };
      switch (id) {
        case "publish":
          return {
            ...base,
            confirm: {
              title: "انتشار محصولات",
              description: (count) =>
                `${faNum(count)} محصول در فروشگاه منتشر می‌شود. محصولات داخل سطل زباله منتشر نمی‌شوند.`,
              confirmText: "بله، منتشر کن",
            },
          };
        case "unpublish":
          return {
            ...base,
            confirm: {
              title: "بازگشت به پیش‌نویس",
              description: (count) =>
                `${faNum(count)} محصول از فروشگاه خارج و به پیش‌نویس‌ها منتقل می‌شود؛ زمان‌بندی‌ها لغو می‌شوند.`,
              confirmText: "بله، به پیش‌نویس ببر",
            },
          };
        case "trash":
          return {
            ...base,
            variant: "danger",
            confirm: {
              title: "انتقال به سطل زباله",
              description: (count) =>
                `${faNum(count)} محصول فوراً از فروشگاه حذف و به سطل زباله منتقل می‌شود. بعداً می‌توانید آن‌ها را بازیابی کنید.`,
              confirmText: "بله، منتقل کن",
            },
          };
        case "restore":
          return {
            ...base,
            confirm: {
              title: "بازیابی محصولات",
              description: (count) =>
                `${faNum(count)} محصول به پیش‌نویس‌ها بازیابی می‌شود و تا انتشار دوباره در فروشگاه نمایش داده نمی‌شود.`,
              confirmText: "بله، بازیابی کن",
            },
          };
        case "purge":
          // The typed confirmation dialog opens from the handler.
          return { ...base, variant: "danger" };
        case "remove_stock":
          return {
            ...base,
            variant: "danger",
            confirm: {
              title: "صفر کردن موجودی",
              description: (count) =>
                `موجودی همهٔ تنوع‌های ${faNum(count)} محصول صفر می‌شود. ادامه می‌دهید؟`,
              confirmText: "بله، صفر کن",
            },
          };
        case "set_stock":
          return {
            ...base,
            confirm: {
              title: "تنظیم موجودی",
              description: (count) =>
                `مقدار واردشده روی همهٔ تنوع‌های ${faNum(count)} محصول اعمال می‌شود.`,
              confirmText: "اعمال",
              input: {
                label: "مقدار موجودی جدید",
                type: "number",
                min: 0,
                placeholder: "مثلاً ۱۰",
                validate: (value) =>
                  value.trim() === "" || !Number.isFinite(Number(value))
                    ? "مقدار موجودی معتبر نیست"
                    : Number(value) < 0
                      ? "موجودی نمی‌تواند منفی باشد"
                      : null,
              },
            },
          };
        default:
          return base;
      }
    });
  }, [can, list.view]);

  const setStockForSelection = useCallback(
    async (rows: AdminProductRow[], count: number) => {
      const variations = rows.flatMap((row) =>
        row.attributes.product_variations.data.map((variation) => ({
          row,
          variation,
        })),
      );
      const items = variations.flatMap(({ variation }) => {
        const stock = variation.attributes.product_stock?.data;
        return stock && Number.isSafeInteger(stock.attributes.StockRevision)
          ? [{ stockId: stock.id, Count: count, expectedStockRevision: stock.attributes.StockRevision! }]
          : [];
      });
      if (!items.length) { toast.error("اطلاعات موجودی دریافت نشد؛ فهرست را دوباره بارگذاری کنید"); return; }
      const progress = toast.loading("در حال ذخیره موجودی...");
      try {
        const results = await updateBulkProductStock(items);
        const succeeded = results.filter((item) => item.success).length;
        const failed = results.filter((item) => !item.success);
        if (succeeded) { toast.success(`موجودی ${faNum(succeeded)} تنوع ذخیره شد`); refreshAll(); }
        if (failed.length) {
          const busy = failed.some((item) => item.errorCode === "EDIT_LEASE_CONFLICT");
          toast.error(busy ? "موجودی بعضی محصولات تغییر نکرد؛ محصول در حال ویرایش است" : "موجودی بعضی تنوع‌ها تغییر کرده است؛ فهرست را دوباره بارگذاری کنید");
        }
        if (items.length < variations.length) toast.error("اطلاعات موجودی بعضی تنوع‌ها دریافت نشده است");
      } catch {
        toast.error("نتیجه ذخیره موجودی تأیید نشد؛ فهرست را دوباره بارگذاری کنید");
      } finally { toast.dismiss(progress); }

    },
    [refreshAll],
  );

  const handleBulkAction = useCallback(
    async (
      actionId: string,
      rows: AdminProductRow[],
      context?: BulkActionContext,
    ) => {
      switch (actionId as ProductBulkActionId) {
        case "publish":
          await actions.bulk("publish", rows);
          return;
        case "unpublish":
          await actions.bulk("unpublish", rows);
          return;
        case "trash":
          await actions.bulk("trash", rows);
          return;
        case "restore":
          await actions.bulk("restore", rows);
          return;
        case "schedule":
          setScheduleRequest({ rows });
          return;
        case "purge":
          setPurgeRequest({ rows });
          return;
        case "set_stock": {
          const parsed = Number(context?.input);
          if (!Number.isFinite(parsed)) {
            toast.error("مقدار موجودی معتبر نیست");
            return;
          }
          await setStockForSelection(rows, Math.max(0, Math.trunc(parsed)));
          return;
        }
        case "remove_stock":
          await setStockForSelection(rows, 0);
          return;
        default:
          toast.error("عملیات نامعتبر");
      }
    },
    [actions, setStockForSelection],
  );

  const confirmSchedule = useCallback(
    async (publishAt: string) => {
      if (!scheduleRequest) return;
      setDialogBusy(true);
      try {
        const done =
          scheduleRequest.rows.length === 1
            ? await actions.setPublication(
                scheduleRequest.rows[0],
                "schedule",
                publishAt,
              )
            : Boolean(
                await actions.bulk("schedule", scheduleRequest.rows, {
                  publishAt,
                }),
              );
        if (done) setScheduleRequest(null);
      } finally {
        setDialogBusy(false);
      }
    },
    [actions, scheduleRequest],
  );

  const confirmPurge = useCallback(async () => {
    if (!purgeRequest) return;
    setDialogBusy(true);
    try {
      if ("emptyTrash" in purgeRequest) {
        await actions.emptyTrash(trashLoadedAt || new Date().toISOString());
      } else if (purgeRequest.rows.length === 1) {
        await actions.purge(purgeRequest.rows[0]);
      } else {
        await actions.bulk("purge", purgeRequest.rows);
      }
      setPurgeRequest(null);
    } finally {
      setDialogBusy(false);
    }
  }, [actions, purgeRequest, trashLoadedAt]);

  const loadProducts = useCallback(
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
      const requestedAt = new Date().toISOString();
      const response = await listAdminProducts({
        view: list.view,
        sort: list.sort,
        page,
        pageSize,
        ...list.criteria,
        filters,
        signal,
      });
      if (list.view === "trash") setTrashLoadedAt(requestedAt);
      setTrashRetentionDays(response.meta?.trashRetentionDays ?? 0);
      return response;
    },
    [list.criteria, list.sort, list.view],
  );

  const tabBadge = (key: (typeof PRODUCT_VIEW_TABS)[number]["key"]) =>
    counts.loading && !counts.counts
      ? "…"
      : counts.counts
        ? faNum(counts.counts[key])
        : "—";

  const empty = VIEW_EMPTY_STATE[list.view];
  const trashCount = counts.counts?.trash ?? 0;

  return (
    <ContentWrapper
      title="محصولات"
      hasAddButton={canCreate}
      addButtonText="محصول جدید"
      addButtonPath="/products/add"
      hasFilterButton
      filterOptions={PRODUCT_FILTER_OPTIONS}
      filters={list.advancedFilters}
      onFiltersChange={list.setAdvancedFilters}
      hasPagination
    >
      <div className="mb-3">
        <SubNav
          ariaLabel="چرخهٔ عمر محصولات"
          items={PRODUCT_VIEW_TABS.map((tab) => ({
            id: tab.key,
            label: tab.label,
            badge: tabBadge(tab.key),
          }))}
          activeId={list.view}
          onSelect={(id) => list.setView(id as typeof list.view)}
        />
        {counts.error && (
          <p className="mt-2 text-xs text-amber-700" role="status">
            {counts.error}
          </p>
        )}
      </div>

      {list.view === "trash" && (
        <div
          className="mb-3 flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between"
          data-testid="admin-products-trash-notice"
        >
          <span>
            {retentionDays > 0
              ? `محصولات سطل زباله پس از ${faNum(retentionDays)} روز برای همیشه حذف می‌شوند.`
              : "محصولات سطل زباله در فروشگاه نمایش داده نمی‌شوند و تا زمانی که آن‌ها را بازیابی یا برای همیشه حذف کنید، اینجا می‌مانند."}
          </span>
          {can.delete && trashCount > 0 && (
            <button
              type="button"
              onClick={() =>
                setPurgeRequest({ emptyTrash: true, count: trashCount })
              }
              className="inline-flex h-9 shrink-0 items-center gap-1.5 self-start rounded-lg border border-red-200 bg-white px-3 text-xs font-medium text-red-700 hover:bg-red-50 sm:self-auto"
              data-testid="admin-products-empty-trash"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              خالی کردن سطل زباله
            </button>
          )}
        </div>
      )}

      <ProductListToolbar
        view={list.view}
        search={list.search}
        sort={list.sort}
        categoryId={list.categoryId}
        stock={list.stock}
        productType={list.productType}
        activeFilterCount={list.activeFilterCount}
        onSearch={list.setSearch}
        onSort={list.setSort}
        onCategory={list.setCategory}
        onStock={list.setStock}
        onProductType={list.setProductType}
        onClear={list.clearFilters}
      />

      <SuperAdminTable
        columns={columns}
        filters={list.advancedFilters}
        dataLoader={loadProducts}
        dataLoaderKey={JSON.stringify({
          view: list.view,
          sort: list.sort,
          criteria: list.criteria,
        })}
        refreshOnVisibility={false}
        getRowId={(row: AdminProductRow) => String(row.id)}
        enableSelection={bulkOptions.length > 0}
        bulkOptions={bulkOptions}
        onBulkAction={handleBulkAction}
        isFiltered={list.isFiltered}
        onClearFilters={list.clearFilters}
        emptyState={
          list.isFiltered ? (
            <FilteredEmptyState onClearFilters={list.clearFilters} />
          ) : (
            <EmptyState title={empty.title} description={empty.description} />
          )
        }
        mobileTable={(data, selectionProps) => (
          <ProductMobileList
            data={data}
            view={list.view}
            selectionProps={selectionProps}
            renderActions={renderActions}
          />
        )}
      />

      {scheduleRequest && (
        <ScheduleProductsDialog
          isOpen
          productCount={scheduleRequest?.rows.length ?? 0}
          productTitle={
            scheduleRequest?.rows.length === 1
              ? scheduleRequest.rows[0].attributes.Title
              : undefined
          }
          currentPublishAt={scheduleRequest?.currentPublishAt}
          busy={dialogBusy}
          onConfirm={(publishAt) => void confirmSchedule(publishAt)}
          onCancel={() => !dialogBusy && setScheduleRequest(null)}
        />
      )}

      {purgeRequest && (
        <PermanentDeleteDialog
          isOpen
          productTitle={
            purgeRequest &&
            "rows" in purgeRequest &&
            purgeRequest.rows.length === 1
              ? purgeRequest.rows[0].attributes.Title
              : undefined
          }
          count={
            purgeRequest
              ? "rows" in purgeRequest
                ? purgeRequest.rows.length
                : purgeRequest.count
              : 0
          }
          emptyTrash={Boolean(purgeRequest && "emptyTrash" in purgeRequest)}
          busy={dialogBusy}
          onConfirm={() => void confirmPurge()}
          onCancel={() => !dialogBusy && setPurgeRequest(null)}
        />
      )}
    </ContentWrapper>
  );
}
