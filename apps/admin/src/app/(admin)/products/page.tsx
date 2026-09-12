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
import { useCan } from "@/hooks/useCan";
import {
  restoreProduct,
  softDeleteProduct,
} from "@/services/super-admin/product/removal";
import { changeProductPublication } from "@/services/super-admin/product/publication";
import { runBulkAction } from "@/lib/bulkActions";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import type {
  BulkActionContext,
  BulkActionOption,
} from "@/components/SuperAdmin/Table/bulkActions";
import {
  type AdvancedFilterField,
  type AdvancedFilterItem,
} from "@/components/SuperAdmin/Table/advancedFilters";
import {
  listAdminProducts,
  type AdminProductSort,
} from "@/services/super-admin/product/list";
import { useLegacyFilterQueryCleanup } from "@/hooks/useLegacyFilterQueryCleanup";

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
  // Two different things, deliberately kept apart: `product.delete` is permanent
  // deletion (Superadmin-only), `product.softDelete` is the reversible move to
  // the recycle bin that Seller 1 and up can perform.
  const canDeleteProduct = useCan("product.delete");
  const canSoftDeleteProduct = useCan("product.softDelete");
  const canRestoreProduct = useCan("product.restore");
  const canUpdateStock = useCan("product.stock.update");
  const canPublishProduct = useCan("product.publish");
  const [isRecycleBinOpen, setIsRecycleBinOpen] = useState(false);
  const [sort, setSort] = useState<ProductSort>("last-edited");
  const [, setPage] = useQueryState("page", { defaultValue: "1" });
  useLegacyFilterQueryCleanup();
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

  /** Every variation row of the selection, for the stock and publish actions. */
  const variationsOf = (products: Product[]) =>
    products.flatMap((product) =>
      product.attributes.product_variations.data.map((variation) => ({
        product,
        variation,
      })),
    );

  const setStockForSelection = useCallback(
    async (selectedProducts: Product[], count: number, verb: string) => {
      const result = await runBulkAction(variationsOf(selectedProducts), {
        skip: ({ variation }) =>
          variation.attributes.product_stock?.data?.id
            ? null
            : "این تنوع رکورد موجودی ندارد",
        execute: ({ variation }) =>
          apiClient.put(
            `/product-stocks/${variation.attributes.product_stock!.data.id}`,
            { data: { Count: count } },
          ),
        messages: {
          progress: (total) => `در حال ${verb} موجودی ${total} تنوع محصول...`,
          success: (ok) => `موجودی ${ok} تنوع محصول ${verb} شد`,
          failure: (failed, reasons) =>
            `موجودی ${failed} تنوع تغییر نکرد. ${reasons.join("؛ ")}`,
          skipped: (skipped) => `${skipped} تنوع رکورد موجودی نداشت.`,
          allSkipped: () => "هیچ‌کدام از تنوع‌های انتخاب‌شده رکورد موجودی ندارند.",
        },
      });
      if (result.succeeded.length > 0) setRefresh(true);
    },
    [setRefresh],
  );

  const setPublicationForSelection = useCallback(
    async (selectedProducts: Product[], action: "publish-now" | "unpublish") => {
      const verb = action === "publish-now" ? "انتشار" : "لغو انتشار";
      const result = await runBulkAction(selectedProducts, {
        // Goes through the publication endpoint rather than PUTing IsPublished on
        // each variation: that older path never touched the product's own Status,
        // so «انتشار محصولات» left the product unpublished. It is also the action
        // the product.publish capability actually gates.
        execute: (product) => changeProductPublication(product.id, { action }),
        describeError: (error) =>
          getUserFacingErrorMessage(error, "دلیل نامشخص"),
        messages: {
          progress: (total) => `در حال ${verb} ${total} محصول...`,
          success: (ok) => `${ok} محصول ${verb} شد`,
          failure: (failed, reasons) =>
            `${verb} ${failed} محصول انجام نشد. ${reasons.join("؛ ")}`,
        },
      });
      if (result.succeeded.length > 0) setRefresh(true);
    },
    [setRefresh],
  );

  const handleBulkAction = useCallback(
    async (
      actionId: string,
      selectedProducts: Product[],
      context?: BulkActionContext,
    ) => {
      // The toolbar already refuses an empty selection; this guards direct calls.
      if (!selectedProducts.length) {
        toast.error("هیچ محصولی انتخاب نشده است");
        return;
      }

      switch (actionId) {
        case "remove_stock":
          if (!canUpdateStock) return;
          await setStockForSelection(selectedProducts, 0, "حذف");
          return;

        case "set_stock": {
          if (!canUpdateStock) return;
          // The value comes from the toolbar's confirm dialog. It used to come
          // from window.prompt(), a blocking native dialog validated after the
          // fact.
          const parsed = Number(context?.input);
          if (!Number.isFinite(parsed)) {
            toast.error("مقدار موجودی معتبر نیست");
            return;
          }
          await setStockForSelection(
            selectedProducts,
            Math.max(0, Math.trunc(parsed)),
            "تنظیم",
          );
          return;
        }

        case "publish":
          if (!canPublishProduct) return;
          await setPublicationForSelection(selectedProducts, "publish-now");
          return;

        case "unpublish":
          if (!canPublishProduct) return;
          await setPublicationForSelection(selectedProducts, "unpublish");
          return;

        case "soft_delete": {
          if (!canSoftDeleteProduct) return;
          const result = await runBulkAction(selectedProducts, {
            // Dedicated endpoint, not PUT { removedAt }: that field is outside
            // the backend's operational allowlist and 400s for every
            // non-Superadmin.
            execute: (product) => softDeleteProduct(product.id),
            describeError: (error) =>
              getUserFacingErrorMessage(error, "دلیل نامشخص"),
            messages: {
              progress: (total) => `در حال حذف ${total} محصول...`,
              success: (ok) => `${ok} محصول با موفقیت حذف شد`,
              failure: (failed, reasons) =>
                `حذف ${failed} محصول انجام نشد. ${reasons.join("؛ ")}`,
            },
          });
          if (result.succeeded.length > 0) setRefresh(true);
          return;
        }

        case "restore": {
          if (!canRestoreProduct) return;
          const result = await runBulkAction(selectedProducts, {
            execute: (product) => restoreProduct(product.id),
            describeError: (error) =>
              getUserFacingErrorMessage(error, "دلیل نامشخص"),
            messages: {
              progress: (total) => `در حال بازیابی ${total} محصول...`,
              success: (ok) => `${ok} محصول با موفقیت بازیابی شد`,
              failure: (failed, reasons) =>
                `بازیابی ${failed} محصول انجام نشد. ${reasons.join("؛ ")}`,
            },
          });
          if (result.succeeded.length > 0) setRefresh(true);
          return;
        }

        case "permanent_delete": {
          if (!canDeleteProduct) return;
          const result = await runBulkAction(selectedProducts, {
            execute: (product) => apiClient.delete(`/products/${product.id}`),
            describeError: (error) =>
              getUserFacingErrorMessage(error, "دلیل نامشخص"),
            messages: {
              progress: (total) => `در حال حذف دائمی ${total} محصول...`,
              success: (ok) => `${ok} محصول برای همیشه حذف شد`,
              failure: (failed, reasons) =>
                `حذف دائمی ${failed} محصول انجام نشد. ${reasons.join("؛ ")}`,
            },
          });
          if (result.succeeded.length > 0) setRefresh(true);
          return;
        }

        default:
          toast.error("عملیات نامعتبر");
      }
    },
    [
      canDeleteProduct,
      canPublishProduct,
      canRestoreProduct,
      canSoftDeleteProduct,
      canUpdateStock,
      setPublicationForSelection,
      setRefresh,
      setStockForSelection,
    ],
  );

  const bulkOptions = useMemo<BulkActionOption[]>(() => {
    if (isRecycleBinOpen) {
      return [
        ...(canRestoreProduct
          ? [{ id: "restore", title: "بازیابی محصولات" }]
          : []),
        ...(canDeleteProduct
          ? [
              {
                id: "permanent_delete",
                title: "حذف دائمی محصولات",
                variant: "danger" as const,
                confirm: {
                  title: "حذف دائمی محصولات",
                  description: (count: number) =>
                    `آیا از حذف دائمی ${count} محصول مطمئن هستید؟ این عملیات غیرقابل برگشت است.`,
                  confirmText: "بله، حذف کن",
                },
              },
            ]
          : []),
      ];
    }
    return [
      ...(canUpdateStock
        ? [
            {
              id: "remove_stock",
              title: "حذف موجودی",
              variant: "danger" as const,
              confirm: {
                title: "حذف موجودی",
                description: (count: number) =>
                  `موجودی همه تنوع‌های ${count} محصول صفر می‌شود. ادامه می‌دهید؟`,
                confirmText: "بله، صفر کن",
              },
            },
            {
              id: "set_stock",
              title: "تنظیم موجودی",
              confirm: {
                title: "تنظیم موجودی",
                description: (count: number) =>
                  `مقدار واردشده روی همه تنوع‌های ${count} محصول اعمال می‌شود.`,
                confirmText: "اعمال",
                input: {
                  label: "مقدار موجودی جدید",
                  type: "number" as const,
                  min: 0,
                  placeholder: "مثلاً ۱۰",
                  validate: (value: string) =>
                    value.trim() === "" || !Number.isFinite(Number(value))
                      ? "مقدار موجودی معتبر نیست"
                      : Number(value) < 0
                        ? "موجودی نمی‌تواند منفی باشد"
                        : null,
                },
              },
            },
          ]
        : []),
      ...(canPublishProduct
        ? [
            { id: "publish", title: "انتشار محصولات" },
            {
              id: "unpublish",
              title: "لغو انتشار محصولات",
              confirm: {
                title: "لغو انتشار محصولات",
                description: (count: number) =>
                  `${count} محصول از فروشگاه خارج می‌شود. ادامه می‌دهید؟`,
                confirmText: "بله، لغو انتشار کن",
              },
            },
          ]
        : []),
      ...(canSoftDeleteProduct
        ? [
            {
              id: "soft_delete",
              title: "حذف محصولات",
              variant: "danger" as const,
              // Permanent delete already confirmed; removing many products at
              // once did not, despite being the easier mistake to make.
              confirm: {
                title: "حذف محصولات",
                description: (count: number) =>
                  `${count} محصول به سطل بازیافت منتقل می‌شود و بعداً قابل بازیابی است.`,
                confirmText: "بله، حذف کن",
              },
            },
          ]
        : []),
    ];
  }, [
    canDeleteProduct,
    canPublishProduct,
    canRestoreProduct,
    canSoftDeleteProduct,
    canUpdateStock,
    isRecycleBinOpen,
  ]);

  return (
    <ContentWrapper
      title="محصولات"
      hasAddButton={canCreateProduct}
      addButtonText="محصول جدید"
      hasFilterButton
      filterOptions={PRODUCT_FILTER_OPTIONS}
      hasPagination
      addButtonPath="/products/add"
      hasRecycleBin={canDeleteProduct || canRestoreProduct || canSoftDeleteProduct}
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

    </ContentWrapper>
  );
}
