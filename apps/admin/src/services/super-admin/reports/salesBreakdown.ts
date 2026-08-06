/**
 * Client for /reports/sales/breakdown — the 5 WooReports parity dimensions that had
 * no existing endpoint (status, category, customer, coupon, geography). "date",
 * "product"/"variation" and "gateway"/"shipping" are already served by
 * /reports/products/{trends,performance,breakdown}; see the shared Sales report page.
 */
import { apiClient } from "@/services";
import { formatQueryParams } from "@/utils/api";
import { API_BASE_URL } from "@/constants/api";
import { getAccessToken } from "@/utils/auth";

export type SalesBreakdownDimension = "status" | "category" | "customer" | "coupon" | "geography";

export const SALES_BREAKDOWN_DIMENSIONS: SalesBreakdownDimension[] = [
  "status",
  "category",
  "customer",
  "coupon",
  "geography",
];

export interface SalesBreakdownRow {
  key: string;
  label: string;
  ordersCount: number;
  units: number;
  grossToman: number;
  discountsToman: number;
  refundsToman: number;
  netToman: number;
}

export interface SalesBreakdownResponse {
  dimension: SalesBreakdownDimension;
  range: { start: string; end: string };
  currency: "Toman";
  timezone: string;
  definitionVersion: string;
  source: string;
  refreshedAt: string;
  partial: boolean;
  truncated: boolean;
  rows: SalesBreakdownRow[];
}

const BASE = "/reports/sales";

export async function getSalesBreakdown(params: {
  dimension: SalesBreakdownDimension;
  start?: string;
  end?: string;
}): Promise<SalesBreakdownResponse> {
  const res = await apiClient.get(`${BASE}/breakdown${formatQueryParams(params as any)}`, {
    cache: "no-store",
  });
  return (res as any).data as SalesBreakdownResponse;
}

/** Downloads the current breakdown as a formatted Excel (.xlsx) file (same query + auth pattern as products). */
export async function downloadSalesBreakdownExcel(params: {
  dimension: SalesBreakdownDimension;
  start?: string;
  end?: string;
}): Promise<void> {
  if (typeof window === "undefined") return;
  const url = `${API_BASE_URL}${BASE}/breakdown/export${formatQueryParams(params as any)}`;
  const token = await getAccessToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = `sales-${params.dimension}-${Date.now()}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}
