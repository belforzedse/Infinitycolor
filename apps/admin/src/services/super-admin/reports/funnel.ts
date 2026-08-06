import { apiClient } from "@/services";
import { formatQueryParams } from "@/utils/api";

export type FunnelStep = "view_item" | "add_to_cart" | "begin_checkout" | "purchase";

export interface FunnelStepRow {
  step: FunnelStep;
  count: number;
  conversionFromPrevious: number | null;
}

export interface FunnelResponse {
  range: { start: string; end: string };
  timezone: string;
  /** false = Matomo unconfigured/unavailable; render an explicit empty state, never a zeroed chart. */
  configured: boolean;
  steps: FunnelStepRow[];
  note: string;
}

export async function getFunnel(params: { start?: string; end?: string }): Promise<FunnelResponse> {
  const res = await apiClient.get(`/reports/funnel${formatQueryParams(params as any)}`, {
    cache: "no-store",
  });
  return (res as any).data as FunnelResponse;
}
