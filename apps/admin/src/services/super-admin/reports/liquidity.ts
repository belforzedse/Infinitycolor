import { apiClient } from "@/services";
import { formatQueryParams } from "@/utils/api";

export type LiquidityInterval = "day" | "week" | "month";

export type LiquidityResult = {
  interval: LiquidityInterval;
  start: string;
  end: string;
  currency: "Toman";
  total: number;
  series: Array<{ bucket: string; total: number }>;
};

export async function getLiquidity(params: {
  start?: string;
  end?: string;
  interval?: LiquidityInterval;
}): Promise<LiquidityResult> {
  const query = formatQueryParams(params as any);
  const res = await apiClient.get(`/reports/liquidity${query}`);
  return (res as any).data as LiquidityResult;
}
