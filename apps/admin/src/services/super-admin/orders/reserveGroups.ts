import type { AdvancedFilterItem } from "@/components/SuperAdmin/Table/advancedFilters";
import { apiClient } from "@/services";

export const ADMIN_RESERVE_GROUPS_ENDPOINT = "/admin/orders-list/reserve-groups/query";

export type ReserveGroupTab =
  | "all"
  | "active"
  | "ending_soon"
  | "ready"
  | "fulfilling"
  | "completed";

export type ReserveGroupSort = "deadline" | "last-activity" | "newest" | "oldest";

export type AdminReserveGroup = {
  id: number;
  groupKey: string;
  state: string | null;
  closureReason: string | null;
  /** True while fulfillment is held; the server refuses shipment actions. */
  isHeld: boolean;
  customer: {
    id: number | null;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  rootOrderId: number | null;
  orderCount: number;
  itemCount: number;
  groupValue: number;
  shippingCostPaid: number;
  shippingMethodTitle: string | null;
  shippingMethodCode: string | null;
  shippingBarcode: string | null;
  destination: string | null;
  activatedAt: string | null;
  expiresAt: string | null;
  closedAt: string | null;
  remainingMs: number | null;
  lastOrderAttachedAt: string | null;
  lastActivityAt: string | null;
};

export type AdminReserveGroupsResponse = {
  data: AdminReserveGroup[];
  meta: {
    pagination: { page: number; pageSize: number; pageCount: number; total: number };
  };
};

export type AdminReserveGroupsInput = {
  page: number;
  pageSize: number;
  tab: ReserveGroupTab;
  sort: ReserveGroupSort;
  search?: string;
  filters?: AdvancedFilterItem[];
  signal?: AbortSignal;
};

/**
 * Reserve operations happen per shipment, not per order, so this list is sourced
 * from the group rows rather than by filtering the order list.
 */
export async function listAdminReserveGroups(
  input: AdminReserveGroupsInput,
): Promise<AdminReserveGroupsResponse> {
  const response = await apiClient.post<AdminReserveGroup[]>(
    ADMIN_RESERVE_GROUPS_ENDPOINT,
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
  const typed = response as unknown as AdminReserveGroupsResponse;
  return {
    data: Array.isArray(typed.data) ? typed.data : [],
    meta: typed.meta,
  };
}

export async function getAdminReserveGroup(
  groupKey: string,
  signal?: AbortSignal,
): Promise<{ data: (AdminReserveGroup & { orders?: unknown[] }) | null }> {
  const response = await apiClient.get<{
    data: (AdminReserveGroup & { orders?: unknown[] }) | null;
  }>(`/admin/orders-list/reserve-groups/${encodeURIComponent(groupKey)}`, {
    signal,
    retries: 0,
  });
  return response as unknown as { data: (AdminReserveGroup & { orders?: unknown[] }) | null };
}
