import { apiClient } from "@/services";

export const ADMIN_DASHBOARD_SUMMARY_ENDPOINT =
  "/admin/dashboard-summary/query";

export type DashboardSummaryOrder = {
  id: number;
  attributes: {
    Status: string | null;
    Date: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    user: {
      data: {
        id: number;
        attributes: {
          user_info: {
            data: {
              id: number;
              attributes: { FirstName: string | null; LastName: string | null };
            } | null;
          };
        };
      } | null;
    };
    contract: {
      data: {
        id: number;
        attributes: { Amount: number };
      } | null;
    };
  };
};

export type DashboardTodayOrderCounts = {
  all: number;
  paying: number;
  inprogress: number;
  completed: number;
  shipped: number;
  cancelled: number;
};

export type AdminDashboardSummary = {
  metrics: {
    ordersTotal: number | null;
    doneOrdersTotal: number | null;
    activeProductsTotal: number | null;
    customerAccountsTotal: number | null;
  };
  todayOrderCounts: DashboardTodayOrderCounts | null;
  activeReserveGroups: number | null;
  latestOrders: DashboardSummaryOrder[];
  latestOrdersAmount: number;
  authorizedModules: {
    orders: boolean;
    products: boolean;
    users: boolean;
    content: boolean;
    productReports: boolean;
    finance: boolean;
    traffic: boolean;
    wallets: boolean;
  };
};

export async function getAdminDashboardSummary(
  signal?: AbortSignal,
): Promise<AdminDashboardSummary> {
  const response = await apiClient.post<AdminDashboardSummary>(
    ADMIN_DASHBOARD_SUMMARY_ENDPOINT,
    {},
    { signal, retries: 0, timeout: 20_000 },
  );
  return (response as unknown as { data: AdminDashboardSummary }).data;
}
