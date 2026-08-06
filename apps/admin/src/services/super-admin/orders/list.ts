import type { Order } from "@/app/(admin)/orders/table";
import type { AdvancedFilterItem } from "@/components/SuperAdmin/Table/advancedFilters";
import { apiClient } from "@/services";

export const ADMIN_ORDERS_LIST_ENDPOINT = "/admin/orders-list/query";

export type AdminOrdersListInput = {
  page: number;
  pageSize: number;
  tab: "all" | "inprogress" | "completed" | "cancelled" | "manual";
  sort: "last-edited" | "newest" | "oldest";
  search?: string;
  filters?: AdvancedFilterItem[];
  signal?: AbortSignal;
};

export type AdminOrdersListResponse = {
  data: Order[];
  meta: {
    pagination: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
};

export async function listAdminOrders(
  input: AdminOrdersListInput,
): Promise<AdminOrdersListResponse> {
  const response = await apiClient.post<Order[]>(
    ADMIN_ORDERS_LIST_ENDPOINT,
    {
      page: input.page,
      pageSize: input.pageSize,
      tab: input.tab,
      sort: input.sort,
      search: input.search?.trim() || undefined,
      filters: input.filters ?? [],
    },
    { signal: input.signal, retries: 0, timeout: 20_000 },
  );
  const typed = response as unknown as AdminOrdersListResponse;
  return {
    data: Array.isArray(typed.data) ? typed.data : [],
    meta: typed.meta,
  };
}
