import { apiClient } from "@/services";

export type BulkStockResult = {
  stockId: number;
  success: boolean;
  errorCode?: string;
  editRevision?: number;
  StockRevision?: number;
};
export async function updateBulkProductStock(
  items: Array<{
    stockId: number;
    Count: number;
    expectedStockRevision: number;
  }>,
) {
  const response = await apiClient.post<{ results: BulkStockResult[] }>(
    "/products/editor/bulk-stock",
    { data: { items } },
    { retries: 0, timeout: 120_000 },
  );
  return response.data.results;
}
