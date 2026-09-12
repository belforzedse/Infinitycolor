import { apiClient } from "@/services";

/**
 * Reversible product removal — the recycle bin, not permanent deletion.
 *
 * These use dedicated endpoints rather than `PUT /products/:id { removedAt }`.
 * `removedAt` is deliberately absent from the backend's operational field
 * allowlist, so the generic update path rejects it for every non-Superadmin;
 * these routes carry their own capability gates (`product.softDelete` and
 * `product.restore`) instead.
 *
 * Permanent deletion is `DELETE /products/:id` behind `product.delete` and is
 * unrelated to either of these.
 */
export type ProductRemovalResponse = {
  id: number;
  removedAt: string | null;
  /** True when the product was already in the requested state; nothing changed. */
  unchanged: boolean;
};

export async function softDeleteProduct(
  productId: string | number,
): Promise<ProductRemovalResponse> {
  const response = await apiClient.post<ProductRemovalResponse>(
    `/products/${productId}/soft-delete`,
    {},
    { retries: 0, timeout: 20_000 },
  );
  return response.data as ProductRemovalResponse;
}

export async function restoreProduct(
  productId: string | number,
): Promise<ProductRemovalResponse> {
  const response = await apiClient.post<ProductRemovalResponse>(
    `/products/${productId}/restore`,
    {},
    { retries: 0, timeout: 20_000 },
  );
  return response.data as ProductRemovalResponse;
}
