import type { AdminProductRow } from "@/components/SuperAdmin/Product/list/types";
import type { AdvancedFilterItem } from "@/components/SuperAdmin/Table/advancedFilters";
import { apiClient } from "@/services";

export const ADMIN_PRODUCTS_LIST_ENDPOINT = "/admin/products-list/query";
export const ADMIN_PRODUCTS_COUNTS_ENDPOINT = "/admin/products-list/counts";

/** Lifecycle tabs. `all` is every product that is not in Trash. */
export const ADMIN_PRODUCT_VIEWS = ["all", "published", "drafts", "scheduled", "trash"] as const;
export type AdminProductView = (typeof ADMIN_PRODUCT_VIEWS)[number];

export const ADMIN_PRODUCT_SORTS = [
  "last-edited",
  "newest",
  "oldest",
  "updated",
  "title",
  "published",
  "scheduled-asc",
  "scheduled-desc",
  "trashed-desc",
  "trashed-asc",
  "stock-asc",
  "stock-desc",
  "sales-asc",
  "sales-desc",
] as const;
export type AdminProductSort = (typeof ADMIN_PRODUCT_SORTS)[number];

export type AdminProductStockFilter = "in" | "out";
export type AdminProductTypeFilter = "Simple" | "Variable";

export type AdminProductCounts = Record<AdminProductView, number>;

/** Search and filters shared by the list and the tab counts. */
export type AdminProductCriteria = {
  search?: string;
  categoryId?: number | null;
  stock?: AdminProductStockFilter | null;
  productType?: AdminProductTypeFilter | null;
  filters?: AdvancedFilterItem[];
};

export type AdminProductsListInput = AdminProductCriteria & {
  view: AdminProductView;
  sort?: AdminProductSort;
  page: number;
  pageSize: number;
  signal?: AbortSignal;
};

export type AdminProductsListResponse = {
  data: AdminProductRow[];
  meta: {
    pagination: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
    view: AdminProductView;
    sort: AdminProductSort;
    counts: AdminProductCounts;
    recycleCount: number;
    /** 0 when automatic Trash cleanup is off. */
    trashRetentionDays: number;
  };
};

function criteriaBody(input: AdminProductCriteria) {
  return {
    search: input.search?.trim() || undefined,
    categoryId: input.categoryId || undefined,
    stock: input.stock || undefined,
    productType: input.productType || undefined,
    filters: input.filters ?? [],
  };
}

export async function listAdminProducts(
  input: AdminProductsListInput,
): Promise<AdminProductsListResponse> {
  const response = await apiClient.post<AdminProductRow[]>(
    ADMIN_PRODUCTS_LIST_ENDPOINT,
    {
      view: input.view,
      sort: input.sort,
      page: input.page,
      pageSize: input.pageSize,
      ...criteriaBody(input),
    },
    { signal: input.signal, retries: 0, timeout: 20_000 },
  );
  const typed = response as unknown as AdminProductsListResponse;
  return {
    data: Array.isArray(typed.data) ? typed.data : [],
    meta: typed.meta,
  };
}

export async function getAdminProductCounts(
  input: AdminProductCriteria & { signal?: AbortSignal },
): Promise<{ counts: AdminProductCounts; trashRetentionDays: number }> {
  const response = await apiClient.post<{ counts: AdminProductCounts; trashRetentionDays: number }>(
    ADMIN_PRODUCTS_COUNTS_ENDPOINT,
    criteriaBody(input),
    { signal: input.signal, retries: 0, timeout: 20_000 },
  );
  return response.data as { counts: AdminProductCounts; trashRetentionDays: number };
}
