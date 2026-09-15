import { apiClient } from "@/services";
import { formatQueryParams } from "@/utils/api";
import type {
  PaidOrdersDefinition,
  ReportClock,
} from "@/services/super-admin/reports/gatewayLiquidity";

export type LiquidityInterval = "day" | "week" | "month";

export type LiquidityPoint = {
  /** Tehran calendar bucket key, `YYYY-MM-DD`. */
  bucket: string;
  total: number;
  orders: number;
};

export type LiquidityResult = {
  interval: LiquidityInterval;
  start: string;
  end: string;
  currency: "Toman";
  timezone: string;
  clock: ReportClock;
  ordersDefinition: PaidOrdersDefinition;
  total: number;
  ordersCount: number;
  series: LiquidityPoint[];
};

export async function getLiquidity(params: {
  start?: string;
  end?: string;
  interval?: LiquidityInterval;
  clock?: ReportClock;
}): Promise<LiquidityResult> {
  const query = formatQueryParams(params as any);
  const res = await apiClient.get(`/reports/liquidity${query}`);
  return (res as any).data as LiquidityResult;
}
