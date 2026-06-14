// @ts-nocheck

export type SearchwiseAvailability = "in stock" | "out of stock";

export interface SearchwiseProduct {
  id: string;
  title: string;
  subtitle: string;
  link: string;
  image_link: string[];
  availability: SearchwiseAvailability;
  regular_price: number;
  sale_price: number;
  category: string;
  description: Record<string, string | string[]>;
  brand: string;
  GTIN: string;
  color?: string[];
  size?: string[];
}

export interface SearchwiseFeedOptions {
  siteUrl?: string;
  mediaBaseUrl?: string;
  priceMultiplier?: number;
  brand?: string;
}

export interface SearchwisePagination {
  page: number;
  size: number;
  pageCount: number;
  total: number;
}

export const SEARCHWISE_PRODUCT_FILTERS = {
  Status: { $eq: "Active" },
  removedAt: { $null: true },
  Slug: { $notNull: true },
  product_variations: {
    IsPublished: { $eq: true },
    Price: { $gte: 1 },
  },
} as const;

export const SEARCHWISE_PRODUCT_POPULATE = {
  CoverImage: true,
  Media: true,
  product_tags: true,
  product_main_category: {
    populate: {
      parent: {
        populate: {
          parent: {
            populate: {
              parent: true,
            },
          },
        },
      },
    },
  },
  product_other_categories: {
    populate: {
      parent: {
        populate: {
          parent: true,
        },
      },
    },
  },
  product_variations: {
    populate: {
      product_variation_color: true,
      product_variation_size: true,
      product_variation_model: true,
      product_stock: true,
      general_discounts: true,
    },
  },
} as const;

const DEFAULT_SITE_URL = "https://new.infinitycolor.co";
const DEFAULT_MEDIA_BASE_URL = "https://api.infinitycolor.co";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;

const trimSlashes = (value: string): string => value.replace(/\/+$/, "");

const toNumber = (value: unknown): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const normalizeText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const stripHtml = (value: unknown): string =>
  normalizeText(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const attrsOf = (entity: any): any => entity?.attributes || entity || {};

const relationData = (relation: any): any => {
  if (!relation) return null;
  if (Array.isArray(relation)) return relation;
  if (Object.prototype.hasOwnProperty.call(relation, "data")) return relation.data;
  return relation;
};

const relationArray = (relation: any): any[] => {
  const data = relationData(relation);
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
};

const uniqueStrings = (values: Array<string | undefined | null>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

export const getSearchwisePriceMultiplier = (): number => {
  const multiplier = toNumber(process.env.SEARCHWISE_PRICE_TO_RIAL_MULTIPLIER);
  return multiplier > 0 ? multiplier : 10;
};

export const getSearchwiseOptions = (): SearchwiseFeedOptions => ({
  siteUrl:
    process.env.SEARCHWISE_SITE_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.FRONTEND_URL ||
    DEFAULT_SITE_URL,
  mediaBaseUrl:
    process.env.SEARCHWISE_MEDIA_BASE_URL ||
    process.env.URL ||
    process.env.STRAPI_ADMIN_BACKEND_URL ||
    DEFAULT_MEDIA_BASE_URL,
  priceMultiplier: getSearchwisePriceMultiplier(),
  brand: process.env.SEARCHWISE_DEFAULT_BRAND || "",
});

export const parseSearchwisePage = (value: unknown): number => {
  const page = Math.floor(toNumber(value));
  return page > 0 ? page : 1;
};

export const parseSearchwiseSize = (value: unknown): number => {
  const size = Math.floor(toNumber(value));
  if (size <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(size, MAX_PAGE_SIZE);
};

export const isSearchwiseAuthorized = (headers: Record<string, unknown> = {}): boolean => {
  const requiredToken = normalizeText(process.env.SEARCHWISE_FEED_TOKEN);
  if (!requiredToken) return true;

  const normalizedHeaders = new Map<string, string>();
  for (const [key, value] of Object.entries(headers || {})) {
    normalizedHeaders.set(key.toLowerCase(), Array.isArray(value) ? String(value[0] || "") : String(value || ""));
  }

  const directToken = normalizeText(normalizedHeaders.get("x-searchwise-token"));
  const authorization = normalizeText(normalizedHeaders.get("authorization"));
  const bearerToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";

  return directToken === requiredToken || bearerToken === requiredToken;
};

const absoluteUrl = (url: unknown, baseUrl: string): string => {
  const value = normalizeText(url);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `${trimSlashes(baseUrl)}/${value.replace(/^\/+/, "")}`;
};

const mediaUrl = (media: any, mediaBaseUrl: string): string => {
  const attrs = attrsOf(media);
  const mime = normalizeText(attrs.mime);
  if (mime && !mime.startsWith("image/")) return "";
  return absoluteUrl(attrs.url, mediaBaseUrl);
};

const getImageLinks = (product: any, options: SearchwiseFeedOptions): string[] => {
  const attrs = attrsOf(product);
  const mediaBaseUrl = options.mediaBaseUrl || DEFAULT_MEDIA_BASE_URL;
  const urls: string[] = [];

  const coverUrl = mediaUrl(relationData(attrs.CoverImage), mediaBaseUrl);
  if (coverUrl) urls.push(coverUrl);

  for (const item of relationArray(attrs.Media)) {
    const url = mediaUrl(item, mediaBaseUrl);
    if (url) urls.push(url);
  }

  return uniqueStrings(urls);
};

const getCategoryPathParts = (category: any): string[] => {
  const parts: string[] = [];
  let current = relationData(category);
  const seen = new Set<string | number>();

  while (current) {
    const attrs = attrsOf(current);
    const id = current?.id ?? attrs.id ?? normalizeText(attrs.Slug) ?? normalizeText(attrs.Title);
    if (id && seen.has(id)) break;
    if (id) seen.add(id);

    const title = normalizeText(attrs.Title || attrs.Name);
    if (title) parts.unshift(title);
    current = relationData(attrs.parent);
  }

  return parts;
};

const getCategoryPath = (product: any): string => {
  const attrs = attrsOf(product);
  const mainPath = getCategoryPathParts(attrs.product_main_category);
  if (mainPath.length > 0) return mainPath.join(" < ");

  const otherCategory = relationArray(attrs.product_other_categories)[0];
  return getCategoryPathParts(otherCategory).join(" < ");
};

const getVariations = (product: any): any[] => relationArray(attrsOf(product).product_variations);

const getStock = (variation: any): number => {
  const stock = attrsOf(relationData(attrsOf(variation).product_stock));
  const count = toNumber(stock.Count ?? stock.count);
  const reserved = toNumber(stock.reservedCount ?? stock.ReservedCount ?? stock.reserved_count);
  return Math.max(0, count - reserved);
};

const getDiscountPercent = (variation: any): number => {
  for (const discount of relationArray(attrsOf(variation).general_discounts)) {
    const amount = toNumber(attrsOf(discount).Amount);
    if (amount > 0) return amount;
  }
  return 0;
};

const getVariationPricing = (variation: any, multiplier: number) => {
  const attrs = attrsOf(variation);
  const basePrice = toNumber(attrs.Price);
  const explicitDiscountPrice = toNumber(attrs.DiscountPrice);
  const generalDiscount = getDiscountPercent(variation);

  let finalPrice = basePrice;
  if (generalDiscount > 0 && basePrice > 0) {
    finalPrice = Math.max(0, Math.round(basePrice * (1 - generalDiscount / 100)));
  } else if (explicitDiscountPrice > 0 && explicitDiscountPrice < basePrice) {
    finalPrice = explicitDiscountPrice;
  }

  return {
    base: Math.round(basePrice * multiplier),
    sale: Math.round(finalPrice * multiplier),
  };
};

const isPublishedPricedVariation = (variation: any): boolean => {
  const attrs = attrsOf(variation);
  return attrs.IsPublished === true && toNumber(attrs.Price) > 0;
};

const pickDisplayVariation = (variations: any[]): any | null => {
  const published = variations.filter(isPublishedPricedVariation);
  const inStock = published.filter((variation) => getStock(variation) > 0);
  const candidates = inStock.length > 0 ? inStock : published;
  let selected: any | null = null;
  let lowestSale = Infinity;

  for (const variation of candidates) {
    const pricing = getVariationPricing(variation, 1);
    if (pricing.sale > 0 && pricing.sale < lowestSale) {
      selected = variation;
      lowestSale = pricing.sale;
    }
  }

  return selected;
};

const getVariationRelationTitles = (variations: any[], relationName: string): string[] =>
  uniqueStrings(
    variations
      .filter(isPublishedPricedVariation)
      .map((variation) => attrsOf(relationData(attrsOf(variation)[relationName])).Title),
  );

const buildDescription = (
  product: any,
  variations: any[],
  category: string,
): Record<string, string | string[]> => {
  const attrs = attrsOf(product);
  const skus = uniqueStrings(variations.filter(isPublishedPricedVariation).map((variation) => attrsOf(variation).SKU));
  const colors = getVariationRelationTitles(variations, "product_variation_color");
  const sizes = getVariationRelationTitles(variations, "product_variation_size");
  const models = getVariationRelationTitles(variations, "product_variation_model");
  const tags = uniqueStrings(relationArray(attrs.product_tags).map((tag) => attrsOf(tag).Title));
  const description: Record<string, string | string[]> = {};

  if (category) description["دسته بندی"] = category;
  if (normalizeText(attrs.ProductType)) description["نوع محصول"] = normalizeText(attrs.ProductType);
  if (skus.length) description["SKU"] = skus;
  if (colors.length) description["رنگ"] = colors;
  if (sizes.length) description["سایز"] = sizes;
  if (models.length) description["مدل"] = models;
  if (tags.length) description["برچسب ها"] = tags;
  if (stripHtml(attrs.Description)) description["توضیحات"] = stripHtml(attrs.Description);
  if (normalizeText(attrs.CleaningTips)) description["نکات شستشو"] = normalizeText(attrs.CleaningTips);
  if (normalizeText(attrs.ReturnConditions)) description["شرایط بازگشت"] = normalizeText(attrs.ReturnConditions);

  return description;
};

export const buildSearchwiseProduct = (
  product: any,
  options: SearchwiseFeedOptions = getSearchwiseOptions(),
): SearchwiseProduct | null => {
  const attrs = attrsOf(product);
  const slug = normalizeText(attrs.Slug || attrs.slug);
  const title = normalizeText(attrs.Title);
  if (!product?.id || !slug || !title) return null;

  const variations = getVariations(product);
  const displayVariation = pickDisplayVariation(variations);
  if (!displayVariation) return null;

  const multiplier = options.priceMultiplier && options.priceMultiplier > 0 ? options.priceMultiplier : 10;
  const pricing = getVariationPricing(displayVariation, multiplier);
  if (pricing.base <= 0 || pricing.sale <= 0) return null;

  const category = getCategoryPath(product);
  const colors = getVariationRelationTitles(variations, "product_variation_color");
  const sizes = getVariationRelationTitles(variations, "product_variation_size");
  const models = getVariationRelationTitles(variations, "product_variation_model");
  const inStock = variations.some(
    (variation) => isPublishedPricedVariation(variation) && getStock(variation) > 0,
  );

  const item: SearchwiseProduct = {
    id: String(product.id),
    title,
    subtitle: models[0] || "",
    link: `${trimSlashes(options.siteUrl || DEFAULT_SITE_URL)}/pdp/${encodeURIComponent(slug)}`,
    image_link: getImageLinks(product, options),
    availability: inStock ? "in stock" : "out of stock",
    regular_price: pricing.base,
    sale_price: pricing.sale,
    category,
    description: buildDescription(product, variations, category),
    brand: normalizeText(options.brand),
    GTIN: "",
  };

  if (colors.length) item.color = colors;
  if (sizes.length) item.size = sizes;

  return item;
};

export const buildSearchwiseFeedPayload = (
  products: any[],
  pagination?: SearchwisePagination,
  options: SearchwiseFeedOptions = getSearchwiseOptions(),
) => {
  const data = (Array.isArray(products) ? products : [])
    .map((product) => buildSearchwiseProduct(product, options))
    .filter((product): product is SearchwiseProduct => Boolean(product));

  return {
    data,
    meta: {
      generatedAt: new Date().toISOString(),
      ...(pagination ? { pagination } : {}),
    },
  };
};
