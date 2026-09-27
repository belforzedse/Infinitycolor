"use client";

import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { apiClient } from "@/services";
import { ENDPOINTS } from "@/constants/api";
import { faNum } from "@/utils/faNum";
import type {
  AdminProductSort,
  AdminProductStockFilter,
  AdminProductTypeFilter,
  AdminProductView,
} from "@/services/super-admin/product/list";
import { SORT_LABELS, SORTS_BY_VIEW } from "./productLifecycle";

type CategoryOption = { id: number; title: string };

let categoryOptionsCache: Promise<CategoryOption[]> | null = null;

/** Category ids and titles for the quick filter; one request per page load. */
function loadCategoryOptions(): Promise<CategoryOption[]> {
  if (!categoryOptionsCache) {
    categoryOptionsCache = apiClient
      .get<Array<{ id: number; attributes?: { Title?: string } }>>(ENDPOINTS.PRODUCT.CATEGORY, {
        params: {
          "pagination[limit]": -1,
          "fields[0]": "Title",
          sort: "Title:asc",
        },
        cache: "no-store",
      })
      .then((response) => {
        const rows = Array.isArray(response.data) ? response.data : [];
        return rows
          .map((row) => ({ id: Number(row.id), title: String(row.attributes?.Title || "").trim() }))
          .filter((row) => row.id > 0 && row.title);
      })
      .catch((error) => {
        categoryOptionsCache = null;
        throw error;
      });
  }
  return categoryOptionsCache;
}

const SELECT_CLASS =
  "h-10 w-full rounded-lg border border-neutral-300 bg-white px-3 text-sm sm:w-auto sm:min-w-40";

/**
 * Search, sort and the quick filters, with the Orders list's layout. Search
 * types into local state and reaches the URL (and the server) after a pause;
 * every other control writes straight away. Advanced filters stay in the
 * ContentWrapper popover, the same as Orders.
 */
export default function ProductListToolbar({
  view,
  search,
  sort,
  categoryId,
  stock,
  productType,
  activeFilterCount,
  onSearch,
  onSort,
  onCategory,
  onStock,
  onProductType,
  onClear,
}: {
  view: AdminProductView;
  search: string;
  sort: AdminProductSort;
  categoryId: number | null;
  stock: AdminProductStockFilter | null;
  productType: AdminProductTypeFilter | null;
  activeFilterCount: number;
  onSearch: (value: string) => void;
  onSort: (value: AdminProductSort) => void;
  onCategory: (value: number | null) => void;
  onStock: (value: AdminProductStockFilter | null) => void;
  onProductType: (value: AdminProductTypeFilter | null) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(search);
  const [categories, setCategories] = useState<CategoryOption[] | null>(null);
  const [categoriesFailed, setCategoriesFailed] = useState(false);

  useEffect(() => {
    let active = true;
    loadCategoryOptions()
      .then((options) => active && setCategories(options))
      .catch(() => active && setCategoriesFailed(true));
    return () => {
      active = false;
    };
  }, []);

  const commitSearch = useDebouncedCallback((value: string) => onSearch(value), 500);
  useEffect(() => () => commitSearch.cancel(), [commitSearch]);

  // Follow the URL (Back/Forward, "clear filters") without ever writing to it
  // here — React's store-the-previous-prop pattern rather than an effect — but
  // never over keystrokes still waiting to be committed.
  const [followedSearch, setFollowedSearch] = useState(search);
  if (search !== followedSearch) {
    setFollowedSearch(search);
    if (!commitSearch.isPending()) setDraft(search);
  }

  const pending = draft !== search;

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-2xl bg-white/70 p-3 md:bg-transparent md:p-0">
      <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
        <div className="relative w-full md:w-80">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="text"
            placeholder="جستجوی نام، SKU یا شناسهٔ محصول..."
            aria-label="جستجوی محصولات"
            className="h-10 w-full rounded-lg border border-neutral-300 pr-9 pl-8 text-sm"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              commitSearch(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitSearch.flush();
            }}
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            data-testid="admin-products-search"
          />
          {pending ? (
            <span className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          ) : draft ? (
            <button
              type="button"
              aria-label="پاک کردن جستجو"
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-600"
              onClick={() => {
                commitSearch.cancel();
                setDraft("");
                onSearch("");
              }}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>

        <label className="flex flex-col gap-1.5 text-sm text-neutral-600 sm:flex-row sm:items-center sm:gap-2">
          مرتب‌سازی:
          <select
            className={SELECT_CLASS}
            value={sort}
            onChange={(event) => onSort(event.target.value as AdminProductSort)}
            data-testid="admin-products-sort"
          >
            {SORTS_BY_VIEW[view].map((option) => (
              <option key={option} value={option}>
                {SORT_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <select
          className={SELECT_CLASS}
          aria-label="دسته‌بندی"
          value={categoryId ?? ""}
          disabled={!categories && !categoriesFailed}
          onChange={(event) => onCategory(event.target.value ? Number(event.target.value) : null)}
          data-testid="admin-products-category"
        >
          <option value="">
            {categoriesFailed ? "دسته‌بندی‌ها بارگذاری نشد" : "همهٔ دسته‌بندی‌ها"}
          </option>
          {categoryId && categories && !categories.some((option) => option.id === categoryId) && (
            <option value={categoryId}>دسته‌بندی {faNum(categoryId)}</option>
          )}
          {(categories || []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.title}
            </option>
          ))}
        </select>

        <select
          className={SELECT_CLASS}
          aria-label="وضعیت موجودی"
          value={stock ?? ""}
          onChange={(event) => onStock((event.target.value || null) as AdminProductStockFilter | null)}
          data-testid="admin-products-stock"
        >
          <option value="">همهٔ موجودی‌ها</option>
          <option value="in">موجود</option>
          <option value="out">ناموجود</option>
        </select>

        <select
          className={SELECT_CLASS}
          aria-label="نوع محصول"
          value={productType ?? ""}
          onChange={(event) =>
            onProductType((event.target.value || null) as AdminProductTypeFilter | null)
          }
          data-testid="admin-products-type"
        >
          <option value="">همهٔ انواع</option>
          <option value="Variable">متغیر</option>
          <option value="Simple">ساده</option>
        </select>

        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={() => {
              commitSearch.cancel();
              setDraft("");
              onClear();
            }}
            className="inline-flex h-10 items-center gap-1.5 self-start rounded-lg px-3 text-sm text-infinity-primary hover:bg-infinity-primary/5 sm:self-auto"
            data-testid="admin-products-clear-filters"
          >
            <X className="h-4 w-4" aria-hidden />
            پاک کردن فیلترها ({faNum(activeFilterCount)})
          </button>
        )}
      </div>
    </div>
  );
}
