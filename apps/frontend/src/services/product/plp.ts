import type { Metadata } from "next";
import { ENDPOINTS, getStrapiServerUrl } from "@/constants/api";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import { SITE_NAME, SITE_URL } from "@/config/site";
import type { PLPPagination } from "@/components/PLP/types";
import type { Variation } from "@/types/Product";
import fetchWithTimeout from "@/utils/fetchWithTimeout";
import logger from "@/utils/logger";
import { getCategoryAndDescendantSlugs } from "@/utils/category-descendants";
import { getValidatedCategoryCached, type CategoryData } from "@/utils/category-validation";
import { getCategoryPlpHref, getOfferPlpHref, type PLPOffer } from "@/utils/plpRoutes";
import { getProductCategoriesForRender, type ProductCategorySummary } from "./categories";
import { formatProductsToCardProps } from "./product";
import type { ProductSmallCardProps } from "@/components/Product/SmallCard";
import { PRODUCT_COLLECTION_TAG, PRODUCT_TAG } from "@/constants/cacheTags";
import type { CategoryEditorialContent } from "./categoryEditorial";
import { expandSizeKeysToTitles } from "@/utils/plpSizeFilter";
import { expandColorKeysToTitles, type CatalogColor } from "@/utils/plpColorFilter";
import { getProductVariationColors, getProductVariationSizes } from "./variationAttributes";

export interface PLPProduct {
  id: number;
  attributes: {
    Title: string;
    Slug?: string;
    Description?: string;
    Status?: string;
    AverageRating?: number | null;
    RatingCount?: number | null;
    SeenCount?: number | null;
    Price?: number | string | null;
    DiscountPrice?: number | string | null;
    Discount?: number | string | null;
    IsAvailable?: boolean | null;
    InventoryCount?: number | string | null;
    ColorsCount?: number | string | null;
    ColorCodes?: string[] | null;
    createdAt?: string;
    CoverImage?: {
      data?: {
        attributes?: {
          url?: string;
        };
      } | null;
    };
    product_main_category?: {
      data?: {
        attributes?: {
          Title?: string;
          Slug?: string;
        };
      } | null;
    };
    product_variations?: {
      data?: Variation[];
    };
  };
}

export interface PLPQuery {
  category?: string;
  page: number;
  available: boolean;
  minPrice?: string;
  maxPrice?: string;
  size?: string[];
  color?: string[];
  material?: string;
  season?: string;
  gender?: string;
  usage?: string;
  search?: string;
  sort?: string;
  hasDiscount?: boolean;
  // Set by the route (/offer?type=…), never parsed from the shopper's query here.
  offer?: PLPOffer;
}

export interface PLPCategoryContext {
  data: CategoryData;
  slug: string;
  title: string;
  allCategories: ProductCategorySummary[];
  categorySlugs: string[];
}

export interface PLPProductsResult {
  products: PLPProduct[];
  pagination: PLPPagination;
}

export class PLPProductsError extends Error {
  constructor(
    message: string,
    public readonly code: "FETCH_FAILED" | "API_ERROR" | "INVALID_RESPONSE",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PLPProductsError";
  }
}

const PLP_HERO_KEYWORDS = [
  "\u06a9\u06cc\u0641",
  "\u06a9\u0641\u0634",
  "\u0635\u0646\u062f\u0644",
  "\u06a9\u062a\u0648\u0646\u06cc",
];

const PLP_HERO_TITLE_FILTER = PLP_HERO_KEYWORDS
  .map((keyword, index) => `filters[$or][${index}][Title][$containsi]=${encodeURIComponent(keyword)}`)
  .join("&");

const cardToSmallCard = (product: ReturnType<typeof formatProductsToCardProps>[number]): ProductSmallCardProps => ({
  id: product.id,
  slug: product.slug,
  title: product.title,
  category: product.category,
  likedCount: product.seenCount || 0,
  price: product.price,
  discountedPrice: product.discountPrice,
  discount: product.discount,
  image: product.images[0] || "",
  isAvailable: product.isAvailable,
  colorsCount: product.colorsCount,
  colorCodes: product.colorCodes,
});

function parseCsvParam(value: string | string[] | undefined): string[] | undefined {
  const parts = Array.isArray(value)
    ? value.flatMap((item) => item.split(","))
    : typeof value === "string"
      ? value.split(",")
      : [];
  const items = parts.map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function parsePLPQuery(params: { [key: string]: string | string[] | undefined }): PLPQuery {
  const parsedPage = typeof params.page === "string" ? parseInt(params.page, 10) : 1;

  return {
    category: typeof params.category === "string" ? params.category : undefined,
    page: Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    available: typeof params.available === "string" ? params.available === "true" : false,
    minPrice: typeof params.minPrice === "string" ? params.minPrice : undefined,
    maxPrice: typeof params.maxPrice === "string" ? params.maxPrice : undefined,
    size: parseCsvParam(params.size),
    color: parseCsvParam(params.color),
    material: typeof params.material === "string" ? params.material : undefined,
    season: typeof params.season === "string" ? params.season : undefined,
    gender: typeof params.gender === "string" ? params.gender : undefined,
    usage: typeof params.usage === "string" ? params.usage : undefined,
    search: typeof params.search === "string" ? params.search : undefined,
    sort: typeof params.sort === "string" ? params.sort : undefined,
    hasDiscount:
      typeof params.hasDiscount === "string" ? params.hasDiscount === "true" : undefined,
  };
}

const appendIndexedInFilter = (
  params: URLSearchParams,
  prefix: string,
  values: string[],
) => {
  values.forEach((value, index) => {
    params.append(`${prefix}[$in][${index}]`, value);
  });
};

export interface PLPFilterCatalogs {
  sizeTitles?: string[];
  colors?: CatalogColor[];
}

export function buildPLPProductsQuery(
  query: PLPQuery,
  categorySlugs: string[] = [],
  pageSize = 30,
  catalogs: PLPFilterCatalogs = {},
): URLSearchParams {
  const queryParams = new URLSearchParams();
  let andIndex = 0;

  const nextAnd = () => andIndex++;

  queryParams.append("view", "card");
  queryParams.append("pagination[page]", String(query.page));
  queryParams.append("pagination[pageSize]", String(pageSize));
  queryParams.append("requireCoverImage", "true");

  queryParams.append(`filters[$and][${nextAnd()}][Status][$eq]`, "Active");
  queryParams.append(`filters[$and][${nextAnd()}][removedAt][$null]`, "true");

  const variationIndex = nextAnd();
  queryParams.append(`filters[$and][${variationIndex}][product_variations][IsPublished][$eq]`, "true");
  queryParams.append(`filters[$and][${variationIndex}][product_variations][Price][$gt]`, "0");

  if (categorySlugs.length > 0) {
    const categoryIndex = nextAnd();
    appendIndexedInFilter(
      queryParams,
      `filters[$and][${categoryIndex}][$or][0][product_main_category][Slug]`,
      categorySlugs,
    );
    appendIndexedInFilter(
      queryParams,
      `filters[$and][${categoryIndex}][$or][1][product_other_categories][Slug]`,
      categorySlugs,
    );
  }

  if (query.search) {
    const searchIndex = nextAnd();
    queryParams.append(`filters[$and][${searchIndex}][$or][0][Title][$containsi]`, query.search);
    queryParams.append(`filters[$and][${searchIndex}][$or][1][Description][$containsi]`, query.search);
  }

  if (query.available) {
    queryParams.append("availability", "available");
  }
  if (query.minPrice) {
    queryParams.append("price[min]", query.minPrice);
  }
  if (query.maxPrice) {
    queryParams.append("price[max]", query.maxPrice);
  }
  if (query.hasDiscount) {
    queryParams.append("hasDiscount", "true");
  }
  if (query.size && query.size.length > 0) {
    const sizeTitles = expandSizeKeysToTitles(query.size, catalogs.sizeTitles);
    if (sizeTitles.length > 0) {
      appendIndexedInFilter(
        queryParams,
        `filters[$and][${nextAnd()}][product_variations][product_variation_size][Title]`,
        sizeTitles,
      );
    }
  }
  if (query.color && query.color.length > 0) {
    const colorTitles = expandColorKeysToTitles(query.color, catalogs.colors ?? []);
    if (colorTitles.length > 0) {
      appendIndexedInFilter(
        queryParams,
        `filters[$and][${nextAnd()}][product_variations][product_variation_color][Title]`,
        colorTitles,
      );
    }
  }
  if (query.sort) {
    queryParams.append("sort[0]", query.sort);
  }

  // An offer listing's dataset, eligibility and default ranking (curated picks included)
  // are resolved by the backend, so none of the /plp view hints below apply to it.
  if (query.offer) {
    queryParams.append("offer", query.offer);
    return queryParams;
  }

  // True once every ancillary filter is untouched -- no category, search, price,
  // availability, or size/color narrowing. Shared by the excludeDiscount hint below and
  // by the curated-section hint: both only apply to a section's exact unfiltered "View
  // all" URL, and drop out the moment a shopper filters or re-sorts the collection page.
  const hasOnlyBaseFilters =
    categorySlugs.length === 0 &&
    !query.search &&
    !query.available &&
    !query.minPrice &&
    !query.maxPrice &&
    !(query.size && query.size.length > 0) &&
    !(query.color && query.color.length > 0);

  // Hint for a hidden, admin-only setting (site_settings.hideDiscountedOnDefaultNewestPlp,
  // toggled via Strapi/DB only -- there's no UI for it). Only sent for the exact unfiltered
  // default-sort PLP view -- the backend still decides whether to actually honor it.
  const isDefaultNewestUnfilteredView =
    hasOnlyBaseFilters && !query.hasDiscount && query.sort === "LastEditedByAdminAt:desc";
  if (isDefaultNewestUnfilteredView) {
    queryParams.append("excludeDiscount", "true");
  }

  // Hint naming which curated storefront section (see site_settings' homeFavoriteProductIds /
  // homeDiscountedProductIds) this exact "View all" URL maps to, if any. Mirrors the canonical
  // hrefs built in OffersListHomePage/DiscountedShowcase -- the backend independently
  // re-validates the hint against the actual query before honoring it, so a stale or spoofed
  // value just falls back to the plain algorithmic query. Newest is not one of them: its
  // curated picks lead the /offer?type=newest listing instead.
  let curatedSection: "popular" | "discount" | undefined;
  if (hasOnlyBaseFilters) {
    if (query.hasDiscount && !query.sort) {
      curatedSection = "discount";
    } else if (!query.hasDiscount && query.sort === "AverageRating:desc") {
      curatedSection = "popular";
    }
  }
  if (curatedSection) {
    queryParams.append("curated", curatedSection);
  }

  return queryParams;
}

export async function getPLPCategoryContext(
  slug: string | undefined,
): Promise<PLPCategoryContext | null> {
  if (!slug) return null;

  const categoryData = await getValidatedCategoryCached(slug);
  if (!categoryData) return null;

  // Degrades rather than failing the PLP route: without the category list the page still
  // renders, just without descendant-slug expansion (see the fallback below).
  const allCategories = await getProductCategoriesForRender({ revalidate: 3600 });
  const resolvedSlug = categoryData.attributes.Slug;
  const descendantSlugs =
    allCategories.length > 0
      ? getCategoryAndDescendantSlugs(allCategories, resolvedSlug)
      : [];

  return {
    data: categoryData,
    slug: resolvedSlug,
    title: categoryData.attributes.Title || resolvedSlug,
    allCategories,
    categorySlugs: descendantSlugs.length > 0 ? descendantSlugs : [resolvedSlug],
  };
}

function normalizeRelation(rel: any, isVariation = false): any {
  if (!rel) return null;
  if (typeof rel === "object" && "data" in rel) return rel;

  if (Array.isArray(rel)) {
    return {
      data: rel
        .map((item: any) => {
          if (!item) return null;
          if (item.attributes) {
            if (isVariation) {
              const {
                product_stock,
                product_variation_color,
                product_variation_size,
                product_variation_model,
                general_discounts,
                ...rest
              } = item.attributes;
              return {
                ...item,
                attributes: {
                  ...rest,
                  product_stock: normalizeRelation(product_stock),
                  product_variation_color: normalizeRelation(product_variation_color),
                  product_variation_size: normalizeRelation(product_variation_size),
                  product_variation_model: normalizeRelation(product_variation_model),
                  general_discounts: normalizeRelation(general_discounts),
                },
              };
            }
            return item;
          }
          const {
            id,
            product_stock,
            product_variation_color,
            product_variation_size,
            product_variation_model,
            general_discounts,
            ...rest
          } = item;
          const normalized: any = { id, attributes: rest };
          if (isVariation) {
            normalized.attributes.product_stock = normalizeRelation(product_stock);
            normalized.attributes.product_variation_color = normalizeRelation(product_variation_color);
            normalized.attributes.product_variation_size = normalizeRelation(product_variation_size);
            normalized.attributes.product_variation_model = normalizeRelation(product_variation_model);
            normalized.attributes.general_discounts = normalizeRelation(general_discounts);
          }
          return normalized;
        })
        .filter(Boolean),
    };
  }

  if (rel.id !== undefined) {
    const { id, ...rest } = rel;
    return { data: { id, attributes: rest } };
  }

  if (
    typeof rel === "object" &&
    (rel.url !== undefined ||
      rel.formats !== undefined ||
      rel.Title !== undefined ||
      rel.Slug !== undefined)
  ) {
    return { data: { id: rel.id ?? 0, attributes: rel } };
  }

  return null;
}

function normalizeProduct(raw: any): PLPProduct | null {
  if (!raw) return null;
  if (raw.attributes) {
    return {
      ...raw,
      attributes: {
        ...raw.attributes,
        product_main_category: normalizeRelation(raw.attributes.product_main_category),
        product_variations: normalizeRelation(raw.attributes.product_variations, true),
        CoverImage: normalizeRelation(raw.attributes.CoverImage),
      },
    } as PLPProduct;
  }

  const { id, product_main_category, product_variations, CoverImage, ...rest } = raw;
  return {
    id,
    attributes: {
      ...rest,
      product_main_category: normalizeRelation(product_main_category),
      product_variations: normalizeRelation(product_variations, true),
      CoverImage: normalizeRelation(CoverImage),
    },
  } as PLPProduct;
}

export async function getPLPProducts(
  query: PLPQuery,
  categorySlugs?: string[],
  pageSize = 30,
): Promise<PLPProductsResult> {
  const strapiBase = getStrapiServerUrl();
  const baseUrl = `${strapiBase}/products`;
  const catalogs: PLPFilterCatalogs = {};
  if (query.size?.length || query.color?.length) {
    const [sizes, colors] = await Promise.all([
      query.size?.length ? getProductVariationSizes({ revalidate: 3600 }) : Promise.resolve([]),
      query.color?.length ? getProductVariationColors({ revalidate: 3600 }) : Promise.resolve([]),
    ]);
    catalogs.sizeTitles = sizes.map((size) => size.title);
    catalogs.colors = colors;
  }
  const queryParams = buildPLPProductsQuery(query, categorySlugs, pageSize, catalogs);

  const url = `${baseUrl}?${queryParams.toString()}`;
  let response: Response;
  let data: { data?: unknown[]; meta?: { pagination?: { total?: number; pageCount?: number } } };

  try {
    response = await fetchWithTimeout(url, {
      timeoutMs: 15000,
      next: { revalidate: 120, tags: [PRODUCT_TAG, PRODUCT_COLLECTION_TAG] },
    });
    data = await response.json();
  } catch (error) {
    logger.error("[PLP] Products fetch failed", {
      error: String(error),
      urlHint: baseUrl,
    });
    throw new PLPProductsError("Unable to load products", "FETCH_FAILED");
  }

  if (!response.ok) {
    logger.error("[PLP] Products API error", {
      status: response.status,
      url: (response.url || url).replace(/\?.*/, "?..."),
      error: (data as { error?: { message?: string } })?.error?.message ?? String(data),
    });
    throw new PLPProductsError("Products service returned an error", "API_ERROR", response.status);
  }

  try {
    if (!Array.isArray(data?.data)) {
      throw new PLPProductsError("Products response is invalid", "INVALID_RESPONSE");
    }
    const rawProducts = data.data
      .map(normalizeProduct)
      .filter((product): product is PLPProduct => Boolean(product));

    const meta = data.meta?.pagination;
    const total = typeof meta?.total === "number" ? meta.total : rawProducts.length;
    const pageCount =
      typeof meta?.pageCount === "number" ? meta.pageCount : Math.ceil(total / pageSize);

    return {
      products: rawProducts,
      pagination: {
        page: query.page,
        pageSize,
        pageCount,
        total,
      },
    };
  } catch (error) {
    if (error instanceof PLPProductsError) throw error;
    logger.error("[PLP] Error parsing or filtering products", { error: String(error) });
    throw new PLPProductsError("Products response could not be read", "INVALID_RESPONSE");
  }
}

export async function getPLPHeroProducts(categorySlug?: string): Promise<ProductSmallCardProps[]> {
  const strapiBase = getStrapiServerUrl();
  const baseParams =
    `view=card&filters[Status][$eq]=Active&filters[removedAt][$null]=true&` +
    `filters[product_variations][Price][$gte]=1&` +
    `availability=in-stock&`;
  const categoryParam = categorySlug
    ? `&filters[product_main_category][Slug][$eq]=${encodeURIComponent(categorySlug)}`
    : "";

  const fetchCards = async (endpoint: string) => {
    const response = await fetchWithTimeout(`${strapiBase}${endpoint}`, {
      timeoutMs: 10000,
      // Previously untagged, so no product mutation could ever reach it — only
      // the 120s clock could.
      next: { revalidate: 120, tags: [PRODUCT_TAG, PRODUCT_COLLECTION_TAG] },
    });
    if (!response.ok) return [];
    const data = await response.json();
    return formatProductsToCardProps(Array.isArray(data?.data) ? data.data : []);
  };

  try {
    const featuredEndpoint =
      `${ENDPOINTS.PRODUCT.PRODUCT}?${baseParams}${PLP_HERO_TITLE_FILTER}` +
      `${categoryParam}&pagination[pageSize]=6&pagination[withCount]=false`;
    const featured = await fetchCards(featuredEndpoint);
    const source =
      featured.length > 0
        ? featured
        : await fetchCards(
            `${ENDPOINTS.PRODUCT.PRODUCT}?${baseParams}${categoryParam}&pagination[pageSize]=20&pagination[withCount]=false`,
          );

    return source
      .filter((product) => product.images[0])
      .sort(() => Math.random() - 0.5)
      .slice(0, 6)
      .map(cardToSmallCard);
  } catch (error) {
    logger.error("[PLP] Hero products fetch failed", { error: String(error) });
    return [];
  }
}

const OFFER_PAGE_COPY: Record<PLPOffer, { title: string; description: string }> = {
  newest: {
    title: "جدیدترین محصولات",
    description: `جدیدترین محصولات ${SITE_NAME}؛ تازه‌ترین مدل‌ها را زودتر از همه ببینید و بخرید.`,
  },
};

export function getOfferPageTitle(offer: PLPOffer) {
  return OFFER_PAGE_COPY[offer].title;
}

export function buildPLPPageCopy(query: PLPQuery, category?: PLPCategoryContext) {
  if (query.offer) {
    const copy = OFFER_PAGE_COPY[query.offer];
    return {
      pageName: copy.title,
      pageDescription: copy.description,
      url: `${SITE_URL}${getOfferPlpHref(query.offer)}`,
    };
  }

  const pageName = category
    ? `خرید ${category.title}`
    : query.search
      ? `نتایج جستجو برای "${query.search}"`
      : "فروشگاه";
  const pageDescription = category
    ? `خرید ${category.title} با بهترین قیمت و ارسال سریع از ${SITE_NAME}`
    : query.search
      ? `نتایج جستجو برای «${query.search}» در ${SITE_NAME}`
      : `مشاهده و خرید انواع محصولات با بهترین قیمت در ${SITE_NAME}`;
  const pathname = category ? getCategoryPlpHref(category.slug) : "/plp";
  const url = query.search
    ? `${SITE_URL}${pathname}?search=${encodeURIComponent(query.search)}`
    : `${SITE_URL}${pathname}`;

  return { pageName, pageDescription, url };
}

export function buildCollectionItems(products: PLPProduct[]) {
  return products.slice(0, 20).map((product) => {
    const compactPrice = Number(product.attributes.DiscountPrice || product.attributes.Price || 0);
    const variations = product.attributes.product_variations?.data || [];
    const prices = compactPrice > 0
      ? [compactPrice]
      : variations
          .map((v: Variation) => {
            const price = parseFloat(String(v.attributes.Price || "0"));
            const discountPrice = parseFloat(String(v.attributes.DiscountPrice || "0"));
            return discountPrice > 0 ? discountPrice : price;
          })
          .filter((price: number) => price > 0);
    const minPrice = prices.length > 0 ? Math.min(...prices) : undefined;
    const cover: any = product.attributes.CoverImage;
    const coverUrl =
      cover?.data?.attributes?.url ||
      cover?.formats?.small?.url ||
      cover?.formats?.thumbnail?.url ||
      cover?.url;
    const imageUrl = coverUrl ? resolveAssetUrl(coverUrl) || undefined : undefined;
    const productSlug = product.attributes.Slug || product.id.toString();

    return {
      id: product.id,
      title: product.attributes.Title,
      url: `/pdp/${productSlug}`,
      image: imageUrl,
      price: minPrice,
      currency: "IRR",
    };
  });
}

export function buildPLPMetadata(
  query: PLPQuery,
  category?: PLPCategoryContext,
  editorial?: CategoryEditorialContent | null,
): Metadata {
  const baseTitle = "فروشگاه";

  if (query.search) {
    const q = query.search.slice(0, 60);
    const pathname = category ? getCategoryPlpHref(category.slug) : "/plp";
    const title = category
      ? `جستجو در ${category.title}: "${q}"`
      : `نتایج جستجو برای "${q}"`;
    const description = category
      ? `مشاهده نتایج جستجو برای «${q}» در دسته ${category.title}.`
      : `مشاهده نتایج جستجو برای «${q}» در ${SITE_NAME}. جدیدترین و محبوب‌ترین محصولات.`;
    const canonicalUrl = `${SITE_URL}${pathname}?search=${encodeURIComponent(q)}`;

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        type: "website",
        url: canonicalUrl,
      },
      alternates: {
        canonical: canonicalUrl,
      },
    };
  }

  if (category) {
    const title = editorial?.title || `خرید ${category.title}`;
    const description =
      editorial?.seoDescription ||
      `خرید ${category.title} با بهترین قیمت و ارسال سریع از ${SITE_NAME}. جدیدترین محصولات ${category.title}.`;
    const canonicalUrl = `${SITE_URL}${getCategoryPlpHref(category.slug)}`;
    return {
      title,
      description,
      openGraph: {
        title,
        description,
        type: "website",
        url: canonicalUrl,
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
      },
      alternates: {
        canonical: canonicalUrl,
      },
    };
  }

  return {
    title: baseTitle,
    description: `مشاهده و خرید انواع محصولات با بهترین قیمت در ${SITE_NAME}.`,
    alternates: { canonical: `${SITE_URL}/plp` },
  };
}

/** Filters, sort and paging are views of the same listing, so they share one canonical URL. */
export function buildOfferPLPMetadata(offer: PLPOffer): Metadata {
  const { title, description } = OFFER_PAGE_COPY[offer];
  const canonicalUrl = `${SITE_URL}${getOfferPlpHref(offer)}`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      url: canonicalUrl,
    },
    alternates: {
      canonical: canonicalUrl,
    },
  };
}

export function buildInvalidPLPMetadata(): Metadata {
  return {
    title: "فروشگاه",
    description: `مشاهده و خرید انواع محصولات با بهترین قیمت در ${SITE_NAME}.`,
    robots: {
      index: false,
      follow: false,
    },
    alternates: { canonical: `${SITE_URL}/plp` },
  };
}
