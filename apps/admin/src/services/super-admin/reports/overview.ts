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
    /** Merchandise lines PLUS the delivery fee — store-wide only (decision D16). */
    gross: Delta;
    /** Merchandise only: gross − shipping − discounts − refunds. */
    net: Delta;
    units: Delta;
    orders: Delta;
    discounts: Delta;
    refunds: Delta;
    /**
     * The delivery fees already inside `gross`, so the page can take them back
     * out to reach `net`.
     *
     * Optional because admin and API ship as separate images here: against an API
     * older than this field there is no shipping term AND `gross` is still
     * line-only, so the page must fall back to the three-term identity rather
     * than read `undefined.current`.
     */
    shipping?: Delta;
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
