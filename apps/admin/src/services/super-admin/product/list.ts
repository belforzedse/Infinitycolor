import type { Product } from "@/app/(admin)/products/table";
import type { AdvancedFilterItem } from "@/components/SuperAdmin/Table/advancedFilters";
import { apiClient } from "@/services";

export const ADMIN_PRODUCTS_LIST_ENDPOINT = "/admin/products-list/query";

export type AdminProductSort =
  | "last-edited"
  | "newest"
  | "oldest"
  | "stock-asc"
  | "stock-desc"
  | "sales-asc"
  | "sales-desc";

export type AdminProductsListInput = {
  page: number;
  pageSize: number;
  removed: boolean;
  sort: AdminProductSort;
  search?: string;
  filters?: AdvancedFilterItem[];
  signal?: AbortSignal;
};

export type AdminProductsListResponse = {
  data: Product[];
  meta: {
    pagination: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
    recycleCount: number;
  };
};

export async function listAdminProducts(
  input: AdminProductsListInput,
): Promise<AdminProductsListResponse> {
  const response = await apiClient.post<Product[]>(
    ADMIN_PRODUCTS_LIST_ENDPOINT,
    {
      page: input.page,
      pageSize: input.pageSize,
      removed: input.removed,
      sort: input.sort,
      search: input.search?.trim() || undefined,
      filters: input.filters ?? [],
    },
    { signal: input.signal, retries: 0, timeout: 20_000 },
  );
  const typed = response as unknown as AdminProductsListResponse;
  return {
    data: Array.isArray(typed.data) ? typed.data : [],
    meta: typed.meta,
  };
}
