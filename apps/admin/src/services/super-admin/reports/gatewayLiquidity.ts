import { apiClient } from "@/services";
import { formatQueryParams } from "@/utils/api";
import type {
  DataQualityWarning,
  GatewayBreakdownRow,
} from "@/services/super-admin/reports/products";

export type ReportClock = "order" | "settlement";
export type PaidOrdersDefinition = "settled" | "completed";

/**
 * One gateway row of the finance breakdown: the shared `GatewayBreakdownRow`
 * plus the legacy `gatewayId` / `gatewayTitle` keys older callers read.
 */
export type GatewayLiquidityRow = GatewayBreakdownRow & {
  gatewayId: number | null;
  gatewayTitle: string;
};

export type GatewayLiquidityResult = {
  currency: "Toman";
  range: { start: string; end: string };
  clock: ReportClock;
  ordersDefinition: PaidOrdersDefinition;
  /** Distinct paid orders; a split payment sits under two rows. */
  paidOrdersCount: number;
  /**
   * Shipping fees inside the gateway totals, in Toman, over the same paid
   * orders. The gateway rows are cash collected (merchandise + shipping), and
   * this is the term that takes the merchandise half back out — the figure to
   * compare with «فروش خالص» on the overview, which is merchandise-only.
   *
   * Optional because admin and API ship as separate images here: against an API
   * older than this field, absent must stay distinguishable from a real ۰ (every
   * order had free shipping), or the page draws a false identity.
   */
  shippingRevenue?: number;
  rows: GatewayLiquidityRow[];
  dataQualityWarnings?: DataQualityWarning[];
};

export async function getGatewayLiquidity(params: {
  start?: string;
  end?: string;
  clock?: ReportClock;
}): Promise<GatewayLiquidityResult> {
  const query = formatQueryParams(params as any);
  const res = await apiClient.get(`/reports/gateway-liquidity${query}`);
  return (res as any).data as GatewayLiquidityResult;
}
