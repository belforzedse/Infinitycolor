"use client";

import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import type { Product } from "./table";
import { MobileTable, columns } from "./table";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useDebouncedCallback } from "use-debounce";
import { apiClient } from "@/services";
import { useQueryState } from "nuqs";
import toast from "react-hot-toast";
import { useAtom } from "jotai";
import { refreshTable } from "@/components/SuperAdmin/Table";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import { useCan } from "@/hooks/useCan";
import {
  parseAdvancedFiltersParam,
  serializeAdvancedFiltersParam,
  type AdvancedFilterField,
  type AdvancedFilterItem,
} from "@/components/SuperAdmin/Table/advancedFilters";
import {
  listAdminProducts,
  type AdminProductSort,
} from "@/services/super-admin/product/list";

type ProductSort = AdminProductSort;

const PRODUCT_FILTER_OPTIONS: AdvancedFilterField[] = [
  { id: "[Title]", title: "نام محصول", type: "text" },
  { id: "[Slug]", title: "نامک", type: "text" },
  {
    id: "[Status]",
    title: "وضعیت محصول",
    type: "select",
    options: [
      { id: "Active", title: "فعال" },
      { id: "InActive", title: "غیرفعال" },
      { id: "Scheduled", title: "زمان‌بندی شده" },
    ],
  },
  {
    id: "[ProductType]",
    title: "نوع محصول",
    type: "select",
    options: [
      { id: "Simple", title: "ساده" },
      { id: "Variable", title: "متغیر" },
    ],
  },
  {
    id: "[product_main_category][Title]",
    title: "دسته‌بندی اصلی",
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
    title: "موجودی",
    type: "number",
  },
  { id: "[createdAt]", title: "تاریخ ایجاد", type: "date" },
  { id: "[scheduledPublishAt]", title: "تاریخ انتشار زمان‌بندی‌شده", type: "date" },
  { id: "[LastEditedByAdminAt]", title: "آخرین ویرایش", type: "date" },
];

export default function ProductsPage() {
  const canCreateProduct = useCan("product.create");
  const canDeleteProduct = useCan("product.delete");
  const canRestoreProduct = useCan("product.restore");
  const canUpdateStock = useCan("product.stock.update");
  const canPublishProduct = useCan("product.publish");
  const cannotHardDelete = !canDeleteProduct;
  const [isRecycleBinOpen, setIsRecycleBinOpen] = useState(false);
  const [showPermanentDeleteConfirm, setShowPermanentDeleteConfirm] =
    useState(false);
  const [showPermissionDenied, setShowPermissionDenied] = useState(false);
  const [pendingPermanentDelete, setPendingPermanentDelete] = useState<{
    actionId: string;
    selectedProducts: Product[];
  } | null>(null);
  const [sort, setSort] = useState<ProductSort>("last-edited");
  const [, setPage] = useQueryState("page", { defaultValue: "1" });
  const [, setLegacyUrlFilters] = useQueryState<AdvancedFilterItem[]>(
    "filter",
    {
      defaultValue: [],
      parse: parseAdvancedFiltersParam,
      serialize: serializeAdvancedFiltersParam,
    },
  );
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedFilterItem[]>(
    [],
  );
  const [recycleCount, setRecycleCount] = useState(0);
  const [recycleCountError, setRecycleCountError] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [, setRefresh] = useAtom(refreshTable);
  // Skip the mount-time empty search sync — calling setPage("1") then races
  // Next.js Link soft-navigation to /products/:id and cancels the edit route.
  const hasAppliedSearchRef = useRef(false);

  useEffect(() => {
    void setLegacyUrlFilters(null);
  }, [setLegacyUrlFilters]);

  // Debounce search input to avoid excessive API calls
  const debouncedSearch = useDebouncedCallback((query: string) => {
    setDebouncedSearchQuery(query);
    if (!hasAppliedSearchRef.current) {
      hasAppliedSearchRef.current = true;
      return;
    }
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
      try {
        const response = await listAdminProducts({
          page,
          pageSize,
          filters,
          signal,
          removed: isRecycleBinOpen,
          search: debouncedSearchQuery,
          sort,
        });
        setRecycleCountError(false);
        return response;
      } catch (error) {
        if (!signal.aborted) setRecycleCountError(true);
        throw error;
      }
    },
    [debouncedSearchQuery, isRecycleBinOpen, sort],
  );

  const handleMetaChange = useCallback((meta: { recycleCount?: number }) => {
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

  // Bulk actions handler
  const handleBulkAction = useCallback(
    async (actionId: string, selectedProducts: Product[]) => {
      if (!selectedProducts.length) {
        toast.error("هیچ محصولی انتخاب نشده است");
        return;
      }

      try {
        switch (actionId) {
          case "remove_stock":
            // Remove stock from all selected products
            let removedStockCount = 0;
            for (const product of selectedProducts) {
              for (const variation of product.attributes.product_variations
                .data) {
                if (variation.attributes.product_stock?.data?.id) {
                  try {
                    await apiClient.put(
                      `/product-stocks/${variation.attributes.product_stock.data.id}`,
                      {
                        data: { Count: 0 },
                      },
                    );
                    removedStockCount++;
                  } catch (error) {
                    console.error(
                      `Failed to remove stock for variation ${variation.id}:`,
                      error,
                    );
                  }
                }
              }
            }
            toast.success(
              `موجودی ${removedStockCount} تنوع محصول با موفقیت حذف شد`,
            );
            break;

          case "soft_delete": {
            // Soft delete selected products with better error handling
            let deletedCount = 0;
            const failedIds: string[] = [];
            const deletionTime = new Date().toISOString();

            // Show progress toast
            const progressToast = toast.loading(
              `در حال حذف ${selectedProducts.length} محصول...`,
            );

            for (const product of selectedProducts) {
              try {
                await apiClient.put(`/products/${product.id}`, {
                  data: { removedAt: deletionTime },
                });
                deletedCount++;
              } catch (error) {
                console.error(`Failed to delete product ${product.id}:`, error);
                failedIds.push(product.id);
              }
            }

            // Dismiss progress toast
            toast.dismiss(progressToast);

            // Show result toast
            if (deletedCount > 0) {
              const message =
                failedIds.length === 0
                  ? `${deletedCount} محصول با موفقیت حذف شد`
                  : `${deletedCount} محصول حذف شد (${failedIds.length} ناموفق)`;
              toast.success(message);
            }

            if (failedIds.length > 0) {
              toast.error(
                `خطا در حذف ${failedIds.length} محصول. لطفا دوباره سعی کنید.`,
              );
            }

            // Refresh table after deletions
            if (deletedCount > 0) {
              setRefresh(true);
            }
            break;
          }

          case "restore": {
            // Restore selected products with better error handling
            let restoredCount = 0;
            const failedIds: string[] = [];

            // Show progress toast
            const progressToast = toast.loading(
              `در حال بازیابی ${selectedProducts.length} محصول...`,
            );

            for (const product of selectedProducts) {
              try {
                await apiClient.put(`/products/${product.id}`, {
                  data: { removedAt: null },
                });
                restoredCount++;
              } catch (error) {
                console.error(
                  `Failed to restore product ${product.id}:`,
                  error,
                );
                failedIds.push(product.id);
              }
            }

            // Dismiss progress toast
            toast.dismiss(progressToast);

            // Show result toast
            if (restoredCount > 0) {
              const message =
                failedIds.length === 0
                  ? `${restoredCount} محصول با موفقیت بازیابی شد`
                  : `${restoredCount} محصول بازیابی شد (${failedIds.length} ناموفق)`;
              toast.success(message);
            }

            if (failedIds.length > 0) {
              toast.error(
                `خطا در بازیابی ${failedIds.length} محصول. لطفا دوباره سعی کنید.`,
              );
            }

            // Refresh table after restores
            if (restoredCount > 0) {
              setRefresh(true);
            }
            break;
          }

          case "permanent_delete": {
            // Check if user is store manager - deny permanent delete
            if (cannotHardDelete) {
              setShowPermissionDenied(true);
              return;
            }
            // Show confirmation dialog first
            setPendingPermanentDelete({ actionId, selectedProducts });
            setShowPermanentDeleteConfirm(true);
            return; // Don't execute yet, wait for confirmation
          }

          case "set_stock":
            // Set stock to a specific value
            const stockValue = prompt("مقدار موجودی جدید را وارد کنید:");
            if (stockValue && !isNaN(Number(stockValue))) {
              const newStock = Math.max(0, Number(stockValue));
              let updatedStockCount = 0;
              for (const product of selectedProducts) {
                for (const variation of product.attributes.product_variations
                  .data) {
                  if (variation.attributes.product_stock?.data?.id) {
                    try {
                      await apiClient.put(
                        `/product-stocks/${variation.attributes.product_stock.data.id}`,
                        {
                          data: { Count: newStock },
                        },
                      );
                      updatedStockCount++;
                    } catch (error) {
                      console.error(
                        `Failed to update stock for variation ${variation.id}:`,
                        error,
                      );
                    }
                  }
                }
              }
              toast.success(
                `موجودی ${updatedStockCount} تنوع محصول به ${newStock} تنظیم شد`,
              );
            } else if (stockValue !== null) {
              toast.error("مقدار موجودی معتبر نیست");
              return;
            } else {
              return; // User cancelled
            }
            break;

          case "publish":
            // Publish selected products
            let publishedCount = 0;
            for (const product of selectedProducts) {
              for (const variation of product.attributes.product_variations
                .data) {
                try {
                  await apiClient.put(`/product-variations/${variation.id}`, {
                    data: { IsPublished: true },
                  });
                  publishedCount++;
                } catch (error) {
                  console.error(
                    `Failed to publish variation ${variation.id}:`,
                    error,
                  );
                }
              }
            }
            toast.success(`${publishedCount} تنوع محصول منتشر شد`);
            break;

          case "unpublish":
            // Unpublish selected products
            let unpublishedCount = 0;
            for (const product of selectedProducts) {
              for (const variation of product.attributes.product_variations
                .data) {
                try {
                  await apiClient.put(`/product-variations/${variation.id}`, {
                    data: { IsPublished: false },
                  });
                  unpublishedCount++;
                } catch (error) {
                  console.error(
                    `Failed to unpublish variation ${variation.id}:`,
                    error,
                  );
                }
              }
            }
            toast.success(`${unpublishedCount} تنوع محصول از انتشار خارج شد`);
            break;

          default:
            toast.error("عملیات نامعتبر");
            return;
        }

        // Refresh the table after successful operation
        setRefresh(true);
      } catch (error) {
        console.error("Bulk action error:", error);
        toast.error("خطا در انجام عملیات دسته‌جمعی");
      }
    },
    [cannotHardDelete, setRefresh],
  );

  // Bulk action options
  const bulkOptions = useMemo(() => {
    if (isRecycleBinOpen) {
      return [
        ...(canRestoreProduct ? [{ id: "restore", title: "بازیابی محصولات" }] : []),
        ...(canDeleteProduct
          ? [{ id: "permanent_delete", title: "حذف دائمی محصولات" }]
          : []),
      ];
    }
    return [
      ...(canUpdateStock
        ? [
            { id: "remove_stock", title: "حذف موجودی" },
            { id: "set_stock", title: "تنظیم موجودی" },
          ]
        : []),
      ...(canPublishProduct
        ? [
            { id: "publish", title: "انتشار محصولات" },
            { id: "unpublish", title: "لغو انتشار محصولات" },
          ]
        : []),
      ...(canDeleteProduct ? [{ id: "soft_delete", title: "حذف محصولات" }] : []),
    ];
  }, [canDeleteProduct, canPublishProduct, canRestoreProduct, canUpdateStock, isRecycleBinOpen]);

  return (
    <ContentWrapper
      title="محصولات"
      hasAddButton={canCreateProduct}
      addButtonText="محصول جدید"
      hasFilterButton
      filterOptions={PRODUCT_FILTER_OPTIONS}
      hasPagination
      addButtonPath="/products/add"
      hasRecycleBin={canDeleteProduct || canRestoreProduct}
      isRecycleBinOpen={isRecycleBinOpen}
      setIsRecycleBinOpen={handleRecycleBinChange}
      filters={advancedFilters}
      onFiltersChange={handleFiltersChange}
      recycleCount={recycleCount}
      recycleCountError={recycleCountError}
    >
      <div className="mb-3 space-y-3 rounded-2xl bg-white/70 p-3 md:bg-transparent md:p-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex w-full flex-col gap-1.5 sm:w-auto sm:flex-row sm:items-center sm:gap-2">
            <label className="text-sm text-neutral-600">مرتب‌سازی:</label>
            <select
              className="h-10 w-full rounded-lg border border-neutral-300 px-3 py-1 text-sm sm:w-auto sm:min-w-48"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as ProductSort);
                void setPage("1");
              }}
            >
              <option value="last-edited">آخرین ویرایش</option>
              <option value="newest">جدیدترین</option>
              <option value="oldest">قدیمی‌ترین</option>
              <option value="stock-desc">موجودی: بیشترین</option>
              <option value="stock-asc">موجودی: کمترین</option>
              <option value="sales-desc">فروش: بیشترین</option>
              <option value="sales-asc">فروش: کمترین</option>
            </select>
          </div>
        </div>

        <div className="flex w-full flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
          <label className="text-sm text-neutral-600">جستجو:</label>
          <div className="relative w-full sm:w-80">
            <input
              type="text"
              placeholder="جستجو در عنوان محصولات..."
              className="h-10 w-full rounded-lg border border-neutral-300 px-3 py-1 pr-8 text-sm"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
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
        filters={advancedFilters}
        dataLoader={loadProducts}
        dataLoaderKey={JSON.stringify({
          removed: isRecycleBinOpen,
          search: debouncedSearchQuery,
          sort,
        })}
        refreshOnVisibility={false}
        onMetaChange={handleMetaChange}
        mobileTable={(data, selectionProps) => (
          <MobileTable
            data={data}
            enableSelection={selectionProps?.enableSelection}
            selectedIds={selectionProps?.selectedIds}
            onSelectionChange={selectionProps?.onSelectionChange}
          />
        )}
        enableSelection={bulkOptions.length > 0}
        getRowId={(row: Product) => row.id}
        bulkOptions={bulkOptions}
        onBulkAction={handleBulkAction}
      />

      {/* Confirmation dialog for permanent delete */}
      <ConfirmDialog
        isOpen={showPermanentDeleteConfirm}
        title="حذف دائمی محصولات"
        description={`آیا از حذف دائمی ${pendingPermanentDelete?.selectedProducts.length || 0} محصول مطمئن هستید؟ این عملیات غیرقابل برگشت است.`}
        confirmText="بله، حذف کن"
        cancelText="انصراف"
        onConfirm={async () => {
          if (!pendingPermanentDelete) return;

          const { selectedProducts } = pendingPermanentDelete;
          let deletedCount = 0;
          const failedIds: string[] = [];

          // Show progress toast
          const progressToast = toast.loading(
            `در حال حذف دائمی ${selectedProducts.length} محصول...`,
          );

          for (const product of selectedProducts) {
            try {
              await apiClient.delete(`/products/${product.id}`);
              deletedCount++;
            } catch (error) {
              console.error(
                `Failed to permanently delete product ${product.id}:`,
                error,
              );
              failedIds.push(product.id);
            }
          }

          // Dismiss progress toast
          toast.dismiss(progressToast);

          // Show result toast
          if (deletedCount > 0) {
            const message =
              failedIds.length === 0
                ? `${deletedCount} محصول با موفقیت حذف دائمی شد`
                : `${deletedCount} محصول حذف دائمی شد (${failedIds.length} ناموفق)`;
            toast.success(message);
          }

          if (failedIds.length > 0) {
            toast.error(
              `خطا در حذف دائمی ${failedIds.length} محصول. لطفا دوباره سعی کنید.`,
            );
          }

          // Refresh table after deletions
          if (deletedCount > 0) {
            setRefresh(true);
          }

          setShowPermanentDeleteConfirm(false);
          setPendingPermanentDelete(null);
        }}
        onCancel={() => {
          setShowPermanentDeleteConfirm(false);
          setPendingPermanentDelete(null);
        }}
      />

      {/* Permission denied dialog for store managers */}
      <ConfirmDialog
        isOpen={showPermissionDenied}
        title="عدم دسترسی"
        description="شما دسترسی مورد نظر برای این عمل رو ندارید"
        confirmText="باشه"
        cancelText={undefined}
        onConfirm={() => setShowPermissionDenied(false)}
        onCancel={() => setShowPermissionDenied(false)}
      />
    </ContentWrapper>
  );
}
