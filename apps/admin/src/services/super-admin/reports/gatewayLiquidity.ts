import { apiClient } from "@/services";
import { formatQueryParams } from "@/utils/api";

export type GatewayLiquidityRow = {
  gatewayId: number | null;
  gatewayTitle: string;
  total: number;
};

export type GatewayLiquidityResult = {
  currency: "Toman";
  rows: GatewayLiquidityRow[];
};

export async function getGatewayLiquidity(params: {
  start?: string;
  end?: string;
}): Promise<GatewayLiquidityResult> {
  const query = formatQueryParams(params as any);
  const res = await apiClient.get(`/reports/gateway-liquidity${query}`);
  return (res as any).data as GatewayLiquidityResult;
}
