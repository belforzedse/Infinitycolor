import type { Order } from "@/app/(admin)/orders/table";
import type { AdvancedFilterItem } from "@/components/SuperAdmin/Table/advancedFilters";
import { apiClient } from "@/services";

export const ADMIN_ORDERS_LIST_ENDPOINT = "/admin/orders-list/query";
export const ADMIN_ORDERS_COUNTS_ENDPOINT = "/admin/orders-list/counts";
export const ADMIN_ORDERS_SHIPPING_METHODS_ENDPOINT =
  "/admin/orders-list/shipping-methods";

export type AdminOrderTab =
  | "all"
  | "paying"
  | "inprogress"
  | "completed"
  | "shipped"
  | "cancelled"
  | "manual"
  | "anipo_attention";

export type AdminOrderDeliverySearch = {
  cityId?: string | number;
  productCode?: string;
  postalCode?: string;
  addressText?: string;
};

export type AdminOrdersListInput = AdminOrderDeliverySearch & {
  page: number;
  pageSize: number;
  tab: AdminOrderTab;
  sort: "last-edited" | "newest" | "oldest";
  search?: string;
  shippingMethodCodes?: string[];
  filters?: AdvancedFilterItem[];
  signal?: AbortSignal;
};

export type AdminShippingMethodOption = {
  code: string;
  title: string;
};

export type AdminOrderStatusCounts = Record<AdminOrderTab, number>;

export type AdminOrderCountsInput = AdminOrderDeliverySearch & {
  search?: string;
  shippingMethodCodes?: string[];
  filters?: AdvancedFilterItem[];
  signal?: AbortSignal;
};

export type AdminOrderCountsResponse = {
  counts: AdminOrderStatusCounts;
  activeReserveGroups: number;
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
      cityId: input.cityId, productCode: input.productCode, postalCode: input.postalCode, addressText: input.addressText,
      shippingMethodCodes: input.shippingMethodCodes ?? [],
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

export async function getAdminOrderCounts(
  input: AdminOrderCountsInput,
): Promise<AdminOrderCountsResponse> {
  const response = await apiClient.post<AdminOrderCountsResponse>(
    ADMIN_ORDERS_COUNTS_ENDPOINT,
    {
      search: input.search?.trim() || undefined,
      cityId: input.cityId, productCode: input.productCode, postalCode: input.postalCode, addressText: input.addressText,
      shippingMethodCodes: input.shippingMethodCodes ?? [],
      filters: input.filters ?? [],
    },
    { signal: input.signal, retries: 0, timeout: 20_000 },
  );
  return (response as unknown as { data: AdminOrderCountsResponse }).data;
}

export async function listAdminShippingMethods(
  signal?: AbortSignal,
): Promise<AdminShippingMethodOption[]> {
  const response = await apiClient.get<AdminShippingMethodOption[]>(
    ADMIN_ORDERS_SHIPPING_METHODS_ENDPOINT,
    { signal, retries: 0, timeout: 20_000 },
  );

  return Array.isArray(response.data) ? response.data : [];
}
