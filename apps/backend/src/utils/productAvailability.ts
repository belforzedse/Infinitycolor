import { getAvailableStockCount, type Stock } from "../api/cart/services/lib/stock";

const toNumber = (value: unknown): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

/**
 * The unit price a shopper is charged for a variation. It follows the same rule
 * the storefront displays (`buildProductDisplayPriceSql`): the discount counts
 * only when it is above zero and below the base price. 0 means the variation is
 * not for sale -- a missing price or a stray DiscountPrice of 0 must never let
 * an item through checkout for free.
 */
export const chargeableVariationPrice = (
  variation: { Price?: unknown; DiscountPrice?: unknown } | null | undefined,
): number => {
  const price = toNumber(variation?.Price);
  if (price <= 0) return 0;
  const discount = toNumber(variation?.DiscountPrice);
  return discount > 0 && discount < price ? discount : price;
};

export type VariationAvailabilityInput = {
  IsPublished?: boolean | null;
  Price?: number | string | null;
  product_stock?: Stock | null;
};

export const isPurchasableVariation = (
  variation: VariationAvailabilityInput | null | undefined,
): boolean => {
  if (!variation || variation.IsPublished !== true) {
    return false;
  }

  if (toNumber(variation.Price) <= 0) {
    return false;
  }

  return getAvailableStockCount(variation.product_stock ?? undefined) > 0;
};

export const isProductAvailable = (
  variations: Array<VariationAvailabilityInput | null | undefined> | null | undefined,
): boolean => {
  if (!Array.isArray(variations)) return false;
  return variations.some(isPurchasableVariation);
};

export type ProductAvailabilityJoinContext = {
  productVariationProductLinkTable: string;
  productVariationProductJoinColumn: string;
  productVariationProductInverseColumn: string;
  productVariationStockLinkTable: string;
  productVariationStockJoinColumn: string;
  productVariationStockInverseColumn: string;
};

const readJoinTable = (
  metadata: any,
  attributeName: string,
  fallback: {
    table: string;
    joinColumn: string;
    inverseColumn: string;
  },
) => {
  const joinTable = metadata?.attributes?.[attributeName]?.joinTable;
  return {
    table: joinTable?.name || fallback.table,
    joinColumn: joinTable?.joinColumn?.name || fallback.joinColumn,
    inverseColumn: joinTable?.inverseJoinColumn?.name || fallback.inverseColumn,
  };
};

export const getProductAvailabilityJoinContext = (strapi: any): ProductAvailabilityJoinContext => {
  const variationMetadata = strapi?.db?.metadata?.get?.(
    "api::product-variation.product-variation",
  );

  const productLink = readJoinTable(variationMetadata, "product", {
    table: "product_variations_product_links",
    joinColumn: "product_variation_id",
    inverseColumn: "product_id",
  });
  const stockLink = readJoinTable(variationMetadata, "product_stock", {
    table: "product_variations_product_stock_links",
    joinColumn: "product_variation_id",
    inverseColumn: "product_stock_id",
  });

  return {
    productVariationProductLinkTable: productLink.table,
    productVariationProductJoinColumn: productLink.joinColumn,
    productVariationProductInverseColumn: productLink.inverseColumn,
    productVariationStockLinkTable: stockLink.table,
    productVariationStockJoinColumn: stockLink.joinColumn,
    productVariationStockInverseColumn: stockLink.inverseColumn,
  };
};

export const buildProductAvailabilityExistsSql = (
  knex: any,
  ctx: ProductAvailabilityJoinContext,
  productAlias = "p",
): any =>
  knex.raw(
    `EXISTS (
      SELECT 1
      FROM ?? AS pv
      INNER JOIN ?? AS pv_product_link
        ON pv_product_link.?? = pv.id
      INNER JOIN ?? AS pv_stock_link
        ON pv_stock_link.?? = pv.id
      INNER JOIN ?? AS ps
        ON ps.id = pv_stock_link.??
      WHERE pv_product_link.?? = ??.id
        AND pv.is_published = TRUE
        AND COALESCE(pv.price, 0)::numeric > 0
        AND (COALESCE(ps.count, 0) - COALESCE(ps.reserved_count, 0)) > 0
    )`,
    [
      "product_variations",
      ctx.productVariationProductLinkTable,
      ctx.productVariationProductJoinColumn,
      ctx.productVariationStockLinkTable,
      ctx.productVariationStockJoinColumn,
      "product_stocks",
      ctx.productVariationStockInverseColumn,
      ctx.productVariationProductInverseColumn,
      productAlias,
    ],
  );

export const buildProductDisplayPriceSql = (
  knex: any,
  ctx: ProductAvailabilityJoinContext,
  productAlias = "p",
): any =>
  knex.raw(
    `(
      SELECT MIN(
        CASE
          WHEN COALESCE(pv.discount_price, 0)::numeric > 0
            AND COALESCE(pv.discount_price, 0)::numeric < COALESCE(pv.price, 0)::numeric
          THEN COALESCE(pv.discount_price, 0)::numeric
          ELSE COALESCE(pv.price, 0)::numeric
        END
      )
      FROM ?? AS pv
      INNER JOIN ?? AS pv_product_link
        ON pv_product_link.?? = pv.id
      WHERE pv_product_link.?? = ??.id
        AND pv.is_published = TRUE
        AND COALESCE(pv.price, 0)::numeric > 0
    )`,
    [
      "product_variations",
      ctx.productVariationProductLinkTable,
      ctx.productVariationProductJoinColumn,
      ctx.productVariationProductInverseColumn,
      productAlias,
    ],
  );
