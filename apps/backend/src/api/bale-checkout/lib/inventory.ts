import type { Strapi } from "@strapi/strapi";
import { getAvailableStockCount } from "../../cart/services/lib/stock";
import { chargeableVariationPrice } from "../../../utils/productAvailability";
import { publicProductFilters } from "../../../utils/productVisibility";
import { BaleApiError, type BaleItem, type InventoryLookup } from "./protocol";

const VARIATION = "api::product-variation.product-variation" as const;

export async function loadBaleInventory(strapi: Strapi, lookup: InventoryLookup) {
  const keyFilter = "ids" in lookup ? { id: { $in: lookup.ids } } : { SKU: { $in: lookup.skus } };
  const rows = await strapi.db.query(VARIATION).findMany({
    where: { ...keyFilter, IsPublished: true, product: publicProductFilters() },
    select: ["id", "SKU", "Price", "DiscountPrice"],
    populate: { product: { select: ["Title"] }, ...BALE_VARIATION_POPULATE },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => baleInventoryRow(row, row.product?.Title ?? ""));
}

export const BALE_VARIATION_POPULATE = {
  product_variation_color: { select: ["Title"] },
  product_variation_size: { select: ["Title"] },
  product_variation_model: { select: ["Title"] },
  product_stock: { select: ["Count", "reservedCount"] },
} as const;

/** One purchasable variation as the bot sees it. Price is per item, in toman. */
export function baleInventoryRow(row: any, productTitle: string) {
  const priceToman = chargeableVariationPrice(row);
  return {
    variationId: Number(row.id),
    sku: String(row.SKU),
    productTitle,
    color: row.product_variation_color?.Title ?? null,
    size: row.product_variation_size?.Title ?? null,
    model: row.product_variation_model?.Title ?? null,
    priceToman,
    availableQuantity: priceToman > 0 ? getAvailableStockCount(row.product_stock) : 0,
  };
}

export async function validateBaleItemAvailability(strapi: Strapi, items: BaleItem[]) {
  const inventory = await loadBaleInventory(strapi, { ids: items.map(({ variationId }) => variationId) });
  const byId = new Map(inventory.map((row) => [row.variationId, row]));
  const unavailable = items.flatMap(({ variationId, quantity }) => {
    const row = byId.get(variationId);
    return row && row.availableQuantity >= quantity
      ? []
      : [{ variationId, availableQuantity: row?.availableQuantity ?? 0 }];
  });
  if (unavailable.length) {
    throw new BaleApiError(409, "BALE_ITEMS_UNAVAILABLE", "Some items are no longer available in the requested quantity.", {
      items: unavailable,
    });
  }
}
