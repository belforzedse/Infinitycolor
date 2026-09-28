import { resolveAssetUrl } from "@/utils/resolveAssetUrl";
import { TEHRAN_TIMEZONE } from "@/utils/tehranPublicationTime";
import type { AdminProductRow } from "./types";

/** Jalali date in Tehran, e.g. «۵ مهر ۱۴۰۵». */
export function formatTehranDate(value: string | Date): string {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    timeZone: TEHRAN_TIMEZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(value instanceof Date ? value : new Date(value));
}

/** 24-hour wall time in Tehran, e.g. «۱۰:۳۰». */
export function formatTehranTime(value: string | Date): string {
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: TEHRAN_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value instanceof Date ? value : new Date(value));
}

export function productThumbnailUrl(row: AdminProductRow): string | null {
  const image = row.attributes.CoverImage?.data?.attributes;
  const url = image?.formats?.thumbnail?.url || image?.formats?.small?.url || image?.url;
  return url ? resolveAssetUrl(url) || null : null;
}

export function productStockTotal(row: AdminProductRow): number {
  return (row.attributes.product_variations?.data || []).reduce(
    (sum, variation) => sum + (Number(variation?.attributes?.product_stock?.data?.attributes?.Count) || 0),
    0,
  );
}

export function productPrimarySku(row: AdminProductRow): string | null {
  return row.attributes.product_variations?.data?.[0]?.attributes?.SKU ?? null;
}

/** Lowest sale price across priced variations, with the base price it discounts. */
export function productPrice(row: AdminProductRow): { price: number; discount: number | null } | null {
  const priced = (row.attributes.product_variations?.data || [])
    .map((variation) => ({
      price: Number(variation?.attributes?.Price || 0),
      discount: variation?.attributes?.DiscountPrice ? Number(variation.attributes.DiscountPrice) : null,
    }))
    .filter((entry) => entry.price > 0);
  if (priced.length === 0) return null;
  const effective = (entry: { price: number; discount: number | null }) =>
    entry.discount && entry.discount > 0 && entry.discount < entry.price ? entry.discount : entry.price;
  const cheapest = priced.reduce((best, entry) => (effective(entry) < effective(best) ? entry : best));
  const discount = effective(cheapest) < cheapest.price ? effective(cheapest) : null;
  return { price: cheapest.price, discount };
}

export function productVariationSummary(row: AdminProductRow): { total: number; published: number } {
  const variations = row.attributes.product_variations?.data || [];
  return {
    total: variations.length,
    published: variations.filter((variation) => variation?.attributes?.IsPublished === true).length,
  };
}

export function storefrontProductUrl(row: AdminProductRow): string | null {
  const slug = row.attributes.Slug;
  if (!slug) return null;
  const base = (process.env.NEXT_PUBLIC_SITE_BASE_URL || "https://infinitycolor.co").replace(/\/$/, "");
  return `${base}/pdp/${encodeURIComponent(slug)}`;
}
