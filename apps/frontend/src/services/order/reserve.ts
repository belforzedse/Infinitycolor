import { apiClient } from "../index";
import type { ActiveReserveResponse } from "../cart/types/cart";

/** Group-level view of one combined shipment, open or closed. */
export interface CustomerReserveGroup {
  reserveGroupId: string;
  state: string;
  closureReason: string | null;
  expiresAt: string | null;
  activatedAt: string | null;
  closedAt: string | null;
  lastOrderAttachedAt: string | null;
  lastActivityAt: string | null;
  orderCount: number;
  shippingCostPaid: number;
  shippingMethodTitle: string | null;
  destination: string | null;
  rootOrderId: number | null;
  shippingBarcode: string | null;
  isActive: boolean;
}

export interface ReserveGroupListResponse {
  data: CustomerReserveGroup[];
  meta?: {
    pagination?: { page: number; pageSize: number; pageCount: number; total: number };
  };
}

/**
 * Every reserve group the customer has had, newest activity first.
 * Closed groups are included on purpose -- a completed combined shipment is still
 * the record of why those orders travelled together.
 */
export const getMyReserveGroups = async (
  page = 1,
  pageSize = 20,
): Promise<ReserveGroupListResponse> => {
  const response = await apiClient.get<ReserveGroupListResponse>(
    `/orders/reserve-groups?page=${page}&pageSize=${pageSize}`,
  );
  return response.data;
};

/** One group, scoped server-side to its owner. */
export const getMyReserveGroup = async (
  groupKey: string,
): Promise<{ data: CustomerReserveGroup | null }> => {
  const response = await apiClient.get<{ data: CustomerReserveGroup | null }>(
    `/orders/reserve-groups/${encodeURIComponent(groupKey)}`,
  );
  return response.data;
};

/**
 * Get the user's active reserve order (if any), with all linked orders in the group.
 * API returns body { data: null } or { data: { reserveGroupId, reserveExpiresAt, orders, orderCount } }.
 * We return that shape so callers (e.g. Bill) can use result.data.
 */
export const getActiveReserve = async (): Promise<ActiveReserveResponse> => {
  const response = await apiClient.get<ActiveReserveResponse>("/orders/active-reserve");
  return response.data;
};

/**
 * Manually end the reserve window for an order ("Ship Now").
 * Clears reserve flags on all orders in the group.
 */
export const releaseReserve = async (orderId: number): Promise<{ data: { success: boolean; message: string; orderCount: number } }> => {
  const response = await apiClient.post<{ data: { success: boolean; message: string; orderCount: number } }>(
    `/orders/${orderId}/release-reserve`
  );
  return response.data;
};
