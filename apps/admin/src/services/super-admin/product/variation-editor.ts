import type { ProductVariable, ProductVariableDisplay } from "@/components/Product/add/Details/Variable/types";
import type { ProductEditorClient } from "./editor-session";

/** A refreshed editor must retain every row so select-all cannot silently stop at page one. */
export async function loadVariationEditorRows(client: ProductEditorClient, productId: number) {
  const variations: ProductVariable[] = [];
  let page = 1;
  let pageCount = 1;
  do {
    const response = await client.get<ProductVariable[]>(
      `/product-variations?filters[product][id][$eq]=${productId}&populate[0]=product_variation_color&populate[1]=product_variation_size&populate[2]=product_variation_model&populate[3]=product_stock&populate[4]=general_discounts&populate[5]=selected_attribute_terms&populate[6]=selected_attribute_terms.product_attribute&sort=id:asc&pagination[pageSize]=100&pagination[page]=${page}`,
      { cache: "no-store" },
    );
    variations.push(...response.data);
    pageCount = response.meta?.pagination?.pageCount ?? page;
    page += 1;
  } while (page <= pageCount);
  return variations;
}

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
