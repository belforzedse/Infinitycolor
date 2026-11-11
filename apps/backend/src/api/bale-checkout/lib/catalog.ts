import type { Strapi } from "@strapi/strapi";
import { expandSearchTermVariants } from "../../../utils/searchTermVariants";
import { publicProductFilters } from "../../../utils/productVisibility";
import { getSearchwiseOptions } from "../../product/services/searchwise-feed";
import { BALE_VARIATION_POPULATE, baleInventoryRow } from "./inventory";
import { BaleApiError, parsePage, parsePositiveId } from "./protocol";

const PRODUCT = "api::product.product" as const;
const MAX_QUERY_LENGTH = 100;
export const MAX_PRODUCT_PAGE_SIZE = 20;

function absolute(base: string, path: unknown): string | null {
  if (typeof path !== "string" || !path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function serializeProduct(row: any) {
  const { siteUrl, mediaBaseUrl } = getSearchwiseOptions();
  const variations = (row.product_variations ?? [])
    .filter((variation: any) => variation.IsPublished === true)
    .sort((a: any, b: any) => Number(a.id) - Number(b.id))
    .map((variation: any) => baleInventoryRow(variation, row.Title ?? ""));
  const sellable = variations.filter((variation: any) => variation.availableQuantity > 0);
  const prices = sellable.map((variation: any) => variation.priceToman);
  return {
    productId: Number(row.id),
    title: row.Title ?? "",
    category: row.product_main_category?.Title ?? null,
    url: row.Slug ? absolute(siteUrl, `/pdp/${encodeURIComponent(row.Slug)}`) : null,
    imageUrl: absolute(mediaBaseUrl, row.CoverImage?.formats?.medium?.url ?? row.CoverImage?.url),
    minPriceToman: prices.length ? Math.min(...prices) : null,
    inStock: sellable.length > 0,
    variations,
  };
}

const productQuery = {
  select: ["id", "Title", "Slug"],
  populate: {
    CoverImage: { select: ["url", "formats"] },
    product_main_category: { select: ["Title"] },
    product_variations: {
      select: ["id", "SKU", "Price", "DiscountPrice", "IsPublished"],
      populate: BALE_VARIATION_POPULATE,
    },
  },
};

export async function searchBaleProducts(strapi: Strapi, query: Record<string, unknown>) {
  const { page, pageSize } = parsePage(query, MAX_PRODUCT_PAGE_SIZE);
  const q = typeof query.q === "string" ? query.q.trim() : "";
  if (query.q !== undefined && (typeof query.q !== "string" || q.length > MAX_QUERY_LENGTH)) {
    throw new BaleApiError(400, "BALE_INVALID_REQUEST", "q must be at most 100 characters.");
  }
  const variants = expandSearchTermVariants(q);
  const where: Record<string, unknown> = {
    $and: [
      publicProductFilters(),
      // Only products the bot can actually offer: at least one published variation.
      { product_variations: { IsPublished: true } },
      ...(variants.length
        ? [{ $or: variants.flatMap((variant) => [{ Title: { $containsi: variant } }]) }]
        : []),
      ...(query.categoryId !== undefined
        ? [{ product_main_category: { id: parsePositiveId(query.categoryId, "categoryId") } }]
        : []),
    ],
  };
  const [rows, total] = await Promise.all([
    strapi.db.query(PRODUCT).findMany({
      where,
      ...productQuery,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      offset: (page - 1) * pageSize,
      limit: pageSize,
    }),
    strapi.db.query(PRODUCT).count({ where }),
  ]);
  return {
    items: rows.map(serializeProduct),
    pagination: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) },
  };
}

export async function readBaleProduct(strapi: Strapi, productIdParam: unknown) {
  const productId = parsePositiveId(productIdParam, "productId");
  const row = await strapi.db.query(PRODUCT).findOne({
    where: { id: productId, ...publicProductFilters() },
    ...productQuery,
  });
  if (!row) throw new BaleApiError(404, "BALE_PRODUCT_NOT_FOUND", "Product not found.");
  return serializeProduct(row);
}

export async function listBaleProvinces(strapi: Strapi) {
  const rows = await strapi.db.query("api::shipping-province.shipping-province").findMany({
    select: ["id", "Title"],
    orderBy: { Title: "asc" },
  });
  return { items: rows.map((row) => ({ id: Number(row.id), title: row.Title })) };
}

export async function listBaleCities(strapi: Strapi, provinceIdParam: unknown) {
  const provinceId = parsePositiveId(provinceIdParam, "provinceId");
  const province = await strapi.db.query("api::shipping-province.shipping-province").findOne({
    where: { id: provinceId }, select: ["id"],
  });
  if (!province) throw new BaleApiError(404, "BALE_PROVINCE_NOT_FOUND", "Province not found.");
  const rows = await strapi.db.query("api::shipping-city.shipping-city").findMany({
    where: { shipping_province: { id: provinceId } },
    select: ["id", "Title"],
    orderBy: { Title: "asc" },
  });
  return { items: rows.map((row) => ({ id: Number(row.id), title: row.Title })) };
}

export type BaleCity = { cityId: number; cityTitle: string; provinceId: number; provinceTitle: string };

export async function readBaleCity(strapi: Strapi, cityId: number): Promise<BaleCity> {
  const city = await strapi.db.query("api::shipping-city.shipping-city").findOne({
    where: { id: cityId },
    select: ["id", "Title"],
    populate: { shipping_province: { select: ["id", "Title"] } },
  });
  if (!city?.shipping_province) {
    throw new BaleApiError(400, "BALE_INVALID_CITY", "Unknown cityId. Use the cities endpoint.");
  }
  return {
    cityId: Number(city.id),
    cityTitle: city.Title,
    provinceId: Number(city.shipping_province.id),
    provinceTitle: city.shipping_province.Title,
  };
}
