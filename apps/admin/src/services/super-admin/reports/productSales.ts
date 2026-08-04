import { apiClient } from "@/services";
import { formatQueryParams } from "@/utils/api";

export async function getProductSales(params: { start?: string; end?: string }) {
  // No `debug: 1` here on purpose: it made the backend run three extra
  // diagnostic queries on every products-page load, and this function discards
  // the debug payload it paid for. Pass it explicitly when investigating.
  const query = formatQueryParams({ ...(params as any) });
  const res = await apiClient.get(`/reports/product-sales${query}`);
  return (res as any).data as Array<{
    productVariationId: number;
    productTitle: string;
    productSKU: string;
    totalCount: number;
    totalRevenue: number;
  }>;
}
