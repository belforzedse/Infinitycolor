import type { ProductVariableDisplay } from "@/components/Product/add/Details/Variable/types";

export function buildVariationEditorPayload(
  updated: ProductVariableDisplay,
  base: ProductVariableDisplay,
) {
  const data: Record<string, unknown> = {};
  if (updated.sku !== base.sku) data.SKU = updated.sku;
  if (updated.price !== base.price) data.Price = updated.price;
  if ((updated.discountPrice ?? null) !== (base.discountPrice ?? null))
    data.DiscountPrice = updated.discountPrice || null;
  if (updated.isPublished !== base.isPublished)
    data.IsPublished = updated.isPublished;
  if (updated.colorId && updated.colorId !== base.colorId)
    data.product_variation_color = updated.colorId;
  return {
    data,
    ...(updated.stock !== base.stock
      ? {
          stock: {
            ...(base.stockId
              ? { id: base.stockId, expectedStockRevision: base.stockRevision }
              : {}),
            Count: updated.stock,
          },
        }
      : {}),
  };
}
