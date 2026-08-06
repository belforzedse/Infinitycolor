import { apiClient } from "@/services";
import { formatQueryParams } from "@/utils/api";
import type { Delta } from "./products";

export interface OverviewResponse {
  range: { start: string; end: string };
  previous: { start: string; end: string };
  timezone: string;
  currency: "Toman";
  definitionVersion: string;
  sales: {
    gross: Delta;
    net: Delta;
    units: Delta;
    orders: Delta;
    discounts: Delta;
    refunds: Delta;
  };
  traffic: { visits: Delta; visitors: Delta; pageviews: Delta } | null;
  reconciliation: {
    bucketDate: string;
    status: "matched" | "diverged" | "matomo_unavailable";
    ordersDelta: number;
    revenueRatio: number | null;
    possibleCurrencyMismatch: boolean;
    computedAt: string;
  } | null;
}

export async function getOverview(params: { start?: string; end?: string }): Promise<OverviewResponse> {
  const res = await apiClient.get(`/reports/overview${formatQueryParams(params as any)}`, {
    cache: "no-store",
  });
  return (res as any).data as OverviewResponse;
}
