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
  analyticsDelivery: {
    status: "healthy" | "pending" | "attention";
    total: number;
    pending: number;
    processing: number;
    deadLetter: number;
    oldestPendingAt: string | null;
    lastSentAt: string | null;
  } | null;
}

export async function getOverview(params: {
  start?: string;
  end?: string;
}): Promise<OverviewResponse> {
  const res = await apiClient.get(
    `/reports/overview${formatQueryParams(params as any)}`,
    {
      cache: "no-store",
    },
  );
  return (res as any).data as OverviewResponse;
}
