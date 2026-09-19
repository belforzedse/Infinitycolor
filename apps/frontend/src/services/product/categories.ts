import {
  API_BASE_URL,
  getStrapiServerUrl,
  CHECKOUT_REQUEST_TIMEOUT_MS,
  ENDPOINTS,
} from "@/constants/api";
import logger from "@/utils/logger";
import { resolveAssetUrl } from "@/utils/resolveAssetUrl";
import fetchWithTimeout from "@/utils/fetchWithTimeout";

export interface CategoryImageFormats {
  thumbnail?: { url?: string; width?: number; height?: number };
  small?: { url?: string; width?: number; height?: number };
  medium?: { url?: string; width?: number; height?: number };
  large?: { url?: string; width?: number; height?: number };
}

export interface CategoryImageAttributes {
  url?: string;
  alternativeText?: string | null;
  width?: number | null;
  height?: number | null;
  formats?: CategoryImageFormats | null;
}

export interface CategoryImageField {
  data?: {
    attributes?: CategoryImageAttributes;
  } | null;
}

interface CategoryRelation {
  data?: { id: number } | null;
}

interface ChildrenRelation {
  data?: RawProductCategory[] | null;
}

interface RawProductCategory {
  id: number;
  attributes?: {
    Title?: string;
    Slug?: string;
    isMainCategory?: boolean | null;
    featured?: boolean | null;
    homepageOrder?: number | null;
    Image?: CategoryImageField | null;
    MegaMenuImage?: CategoryImageField | null;
    parent?: CategoryRelation | null;
    children?: ChildrenRelation | null;
  };
  Title?: string;
  Slug?: string;
  Color?: string | null;
  isMainCategory?: boolean | null;
  featured?: boolean | null;
  homepageOrder?: number | null;
  Image?: CategoryImageField | null;
  MegaMenuImage?: CategoryImageField | null;
  parent?: CategoryRelation | null;
  children?: ChildrenRelation | null;
}

/**
 * The only category fields the PLP filter reads.
 *
 * `resolveCategoryFilterRule` walks `parentId`, and `buildGroupedCategorySections`
 * groups on `name`/`slug` and rebuilds the tree from `parentId`. The other thirteen
 * fields on `ProductCategorySummary` — both image sets, their dimensions, the
 * mega-menu alt text, `isMainCategory`, `featured`, `homepageOrder`, `hasChildren` —
 * are never read there, yet the whole 238-entry array was serialized into the PLP's client
 * boundary (~85 KB of the RSC payload) on every category page.
 *
 * `ProductCategorySummary` satisfies this structurally, so a caller holding full
 * summaries (the mega menu, the `/plp` client fetch) needs no conversion.
 */
export interface CategoryFilterOption {
  id: number;
  name: string;
  slug: string;
  parentId: number | null;
  children?: CategoryFilterOption[];
}

/** Narrows a full summary to what the PLP filter needs, children included. */
export function toCategoryFilterOption(category: CategoryFilterOption): CategoryFilterOption {
  const { id, name, slug, parentId, children } = category;
  return {
    id,
    name,
    slug,
    parentId,
    ...(children ? { children: children.map(toCategoryFilterOption) } : {}),
  };
}

export interface ProductCategorySummary {
  id: number;
  name: string;
  slug: string;
  imageUrl: string | null;
  imageAlt: string;
  imageWidth?: number | null;
  imageHeight?: number | null;
  megaMenuImageUrl: string | null;
  megaMenuImageAlt: string;
  megaMenuImageWidth?: number | null;
  megaMenuImageHeight?: number | null;
  parentId: number | null;
  isMainCategory: boolean;
  /** True when category has at least one child (only set when children were populated). */
  hasChildren?: boolean;
  /** Direct child categories, populated only when includeChildren is true. */
  children?: ProductCategorySummary[];
  /** True when category is marked as featured in Strapi (for carousel / bottom nav). */
  featured?: boolean;
  /** Lower values appear earlier in the RTL homepage/category rails. */
  homepageOrder?: number;
}

export interface FetchProductCategoriesOptions {
  parentOnly?: boolean;
  mainOnly?: boolean;
  /**
   * When true, only return parent categories that have at least one child.
   * Implies parentOnly. Use for homepage carousel so leaf-only parents are hidden.
   */
  parentsWithChildrenOnly?: boolean;
  /**
   * When true, only return categories marked as featured in Strapi (homepage carousel and bottom nav sheet).
   */
  featuredOnly?: boolean;
  /**
   * When true, populate direct child categories for desktop megamenu links.
   */
  includeChildren?: boolean;
  /**
   * When provided, only return categories whose name includes at least one of these substrings.
   * Fallback when featured is not used; used for homepage carousel and bottom nav category sheet.
   */
  allowedNameSubstrings?: readonly string[];
  limit?: number;
  sort?: string | readonly string[];
  cache?: RequestCache;
  revalidate?: number;
}

export type NavigationCategorySource = "assigned" | "catalog";

interface RawNavigationResponse {
  data?: {
    attributes?: {
      product_categories?: {
        data?: RawProductCategory[] | null;
      } | null;
    };
  } | null;
}

const SERVER_CATEGORY_PAGE_SIZE = 100;
const SERVER_CATEGORY_MAX_PAGES = 50;

/**
 * Raised when the category request itself failed (network error, non-2xx response).
 *
 * Distinct from a successful response that happens to contain no categories: the first
 * must never be cached or rendered as "there are no categories", the second is real data.
 */
export class CategoryFetchError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "CategoryFetchError";
    this.status = status;
  }
}

const resolveCategoryImage = (image?: CategoryImageField | null) => {
  const attrs = image?.data?.attributes;
  if (!attrs) {
    return { url: null, alt: "", width: null, height: null };
  }

  const formats = attrs.formats || undefined;
  const url =
    formats?.large?.url ||
    formats?.medium?.url ||
    formats?.small?.url ||
    formats?.thumbnail?.url ||
    attrs.url ||
    "";

  return {
    url: url ? resolveAssetUrl(url) : null,
    alt: attrs.alternativeText || "",
    width: attrs.width ?? null,
    height: attrs.height ?? null,
  };
};

function dedupeCategoriesById(categories: ProductCategorySummary[]): ProductCategorySummary[] {
  const byId = new Map<number, ProductCategorySummary>();
  for (const c of categories) {
    if (!byId.has(c.id)) byId.set(c.id, c);
  }
  return Array.from(byId.values());
}

function mapProductCategory(
  item: RawProductCategory,
  options: Pick<FetchProductCategoriesOptions, "includeChildren" | "parentsWithChildrenOnly">,
): ProductCategorySummary | null {
  const attrs = item.attributes || item;
  const name = attrs.Title || attrs.Slug || String(item.id);
  const slug = attrs.Slug || String(item.id);
  if (!slug) return null;

  const parentId = attrs.parent?.data?.id ?? null;
  const isMainCategory = Boolean(attrs.isMainCategory);
  const image = resolveCategoryImage(attrs.Image);
  const megaMenuImage = resolveCategoryImage(attrs.MegaMenuImage);
  const parsedHomepageOrder = Number(attrs.homepageOrder ?? 1000);
  const childrenData = attrs.children?.data ?? item.children?.data;
  const hasChildren = Array.isArray(childrenData) && childrenData.length > 0;
  const children =
    options.includeChildren && hasChildren
      ? childrenData
          .map((child) => mapProductCategory(child, { includeChildren: false }))
          .filter((child): child is ProductCategorySummary => Boolean(child))
      : undefined;

  return {
    id: item.id,
    name,
    slug,
    imageUrl: image.url,
    imageAlt: image.alt || name,
    imageWidth: image.width,
    imageHeight: image.height,
    megaMenuImageUrl: megaMenuImage.url,
    megaMenuImageAlt: megaMenuImage.alt || name,
    megaMenuImageWidth: megaMenuImage.width,
    megaMenuImageHeight: megaMenuImage.height,
    parentId,
    isMainCategory,
    hasChildren:
      options.parentsWithChildrenOnly || options.includeChildren ? hasChildren : undefined,
    children,
    featured: Boolean(attrs.featured),
    homepageOrder: Number.isFinite(parsedHomepageOrder) ? parsedHomepageOrder : 1000,
  };
}

export async function getProductCategories(
  options: FetchProductCategoriesOptions = {},
): Promise<ProductCategorySummary[]> {
  const isServerSide = typeof window === "undefined";
  const shouldFetchAllServerPages = isServerSide && options.limit === undefined;
  const params = new URLSearchParams();
  if (shouldFetchAllServerPages) {
    params.set("pagination[page]", "1");
    params.set("pagination[pageSize]", String(SERVER_CATEGORY_PAGE_SIZE));
  } else {
    params.set("pagination[limit]", String(options.limit ?? -1));
  }
  const sort = options.sort || "Title:asc";
  if (typeof sort === "string") {
    params.set("sort", sort);
  } else {
    sort.forEach((value, index) => params.set(`sort[${index}]`, value));
  }
  params.append("fields[0]", "Title");
  params.append("fields[1]", "Slug");
  params.append("fields[2]", "isMainCategory");
  params.append("fields[3]", "featured");
  params.append("fields[4]", "homepageOrder");
  params.append("populate[0]", "Image");
  params.append("populate[1]", "MegaMenuImage");
  params.append("populate[2]", "parent");

  const parentOnly = options.parentOnly || options.parentsWithChildrenOnly || options.mainOnly;
  const shouldPopulateChildren = options.parentsWithChildrenOnly || options.includeChildren;
  if (parentOnly) {
    params.append("filters[parent][id][$null]", "true");
  }
  if (options.mainOnly) {
    params.append("filters[isMainCategory][$eq]", "true");
  }
  if (shouldPopulateChildren) {
    params.append("populate[3]", "children");
  }
  if (!isServerSide) {
    params.append("_skip_global_loader", "1");
  }

  // Use internal URL for server-side fetches to bypass TLS/DNS overhead
  const baseUrl = isServerSide ? getStrapiServerUrl() : API_BASE_URL;
  const buildUrl = () => `${baseUrl}${ENDPOINTS.PRODUCT.CATEGORY}?${params.toString()}`;

  // Server-side: when revalidate is set, use cacheable fetch so Next.js Data Cache is used.
  // Client-side or when cache is explicitly set: respect options.cache (default no-store for fresh data).
  const useCacheable =
    isServerSide && typeof options.revalidate === "number" && options.cache !== "no-store";

  const requestInit: RequestInit & { next?: { revalidate: number } } = {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Encoding": "gzip", // Explicitly request compression
    },
    cache: useCacheable ? "default" : (options.cache ?? "no-store"),
  };

  if (isServerSide && typeof options.revalidate === "number") {
    requestInit.next = { revalidate: options.revalidate };
  }

  try {
    if (isServerSide) {
      logger.info("[ProductCategories] Fetching categories", {
        url: buildUrl().replace(baseUrl, "[BASE_URL]"),
        parentOnly: !!parentOnly,
        mainOnly: !!options.mainOnly,
        parentsWithChildrenOnly: !!options.parentsWithChildrenOnly,
        paginated: shouldFetchAllServerPages,
      });
    }

    const fetchCategoryJson = async () => {
      const url = buildUrl();
      const response = isServerSide
        ? await fetch(url, requestInit)
        : await fetchWithTimeout(url, {
            ...requestInit,
            timeoutMs: CHECKOUT_REQUEST_TIMEOUT_MS,
          });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        if (isServerSide) {
          logger.error("[ProductCategories] Failed to fetch categories", {
            status: response.status,
            statusText: response.statusText,
            error: errorText,
            url: url.replace(baseUrl, "[BASE_URL]"),
          });
        }
        throw new CategoryFetchError(
          `Category request failed with status ${response.status}`,
          response.status,
        );
      }

      return response.json();
    };

    let items: RawProductCategory[] = [];
    if (shouldFetchAllServerPages) {
      for (
        let page = 1, pageCount = 1;
        page <= pageCount && page <= SERVER_CATEGORY_MAX_PAGES;
        page += 1
      ) {
        params.set("pagination[page]", String(page));
        const json = await fetchCategoryJson();

        const pageItems: RawProductCategory[] = Array.isArray(json?.data) ? json.data : [];
        items = items.concat(pageItems);

        const pagination = json?.meta?.pagination;
        const nextPageCount = Number(pagination?.pageCount);
        pageCount = Number.isFinite(nextPageCount) && nextPageCount > 0 ? nextPageCount : page;
      }
    } else {
      const json = await fetchCategoryJson();
      items = Array.isArray(json?.data) ? json.data : [];
    }

    const mapped = items
      .map((item) => mapProductCategory(item, options))
      .filter((item): item is ProductCategorySummary => Boolean(item));

    let result: ProductCategorySummary[];
    if (parentOnly) {
      const noParent = mapped.filter((item) => !item.parentId);
      const deduped = dedupeCategoriesById(noParent);
      result = options.parentsWithChildrenOnly
        ? deduped.filter((c) => c.hasChildren === true)
        : deduped;
    } else {
      result = dedupeCategoriesById(mapped);
    }

    if (options.featuredOnly) {
      const featured = result.filter((c) => c.featured);
      if (featured.length > 0) {
        result = featured;
      } else if (options.allowedNameSubstrings?.length) {
        const substrings = options.allowedNameSubstrings;
        result = result.filter((c) => substrings.some((sub) => c.name.includes(sub)));
      }
    } else if (options.allowedNameSubstrings?.length) {
      const substrings = options.allowedNameSubstrings;
      result = result.filter((c) => substrings.some((sub) => c.name.includes(sub)));
    }

    return result;
  } catch (error) {
    if (typeof window === "undefined") {
      logger.error("[ProductCategories] Unexpected error fetching categories", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // A failed request is not an empty catalog. Returning [] here made callers — and
    // especially useProductCategories' data cache — record a transport failure as a
    // legitimate "this store has no categories" result, which then stuck for the life
    // of the tab. Failure is surfaced so each caller can decide: server components fall
    // back to their designed empty state, the client cache keeps its last known-good
    // data and retries.
    throw error instanceof CategoryFetchError
      ? error
      : new CategoryFetchError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Browser entrypoint for navbar data.
 *
 * The public Strapi endpoint has its own REST cache, but sending every visitor to
 * that origin still makes the API connection/web workers part of navbar
 * availability. This same-origin endpoint is backed by the storefront's shared
 * Redis Cache Components handler, so normal traffic does not reach Strapi at all.
 */
export async function getCachedNavigationProductCategories(
  options: Pick<FetchProductCategoriesOptions, "includeChildren" | "cache"> & {
    source: NavigationCategorySource;
  },
): Promise<ProductCategorySummary[]> {
  const params = new URLSearchParams();
  params.set("includeChildren", options.includeChildren ? "1" : "0");
  params.set("source", options.source);
  params.set("_skip_global_loader", "1");

  try {
    const response = await fetchWithTimeout(`/api/storefront/navigation?${params.toString()}`, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      cache: options.cache ?? "default",
      timeoutMs: CHECKOUT_REQUEST_TIMEOUT_MS,
    });

    if (!response.ok) {
      throw new CategoryFetchError(
        `Cached navigation category request failed with status ${response.status}`,
        response.status,
      );
    }

    const json: unknown = await response.json();
    if (!Array.isArray(json)) {
      throw new CategoryFetchError("Cached navigation category response was not an array");
    }

    return json as ProductCategorySummary[];
  } catch (error) {
    throw error instanceof CategoryFetchError
      ? error
      : new CategoryFetchError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Server-render variant that degrades to an empty list instead of failing the page.
 *
 * Server components render the whole route, so a transient backend blip must not 500 a
 * page that already has a designed empty state. The distinction still matters and is not
 * lost: this wrapper is explicitly named, logs the failure, and is deliberately NOT what
 * the client cache uses — `useProductCategories` needs the rejection so it can keep its
 * last known-good data and retry rather than caching an invented [].
 */
export async function getProductCategoriesForRender(
  options: FetchProductCategoriesOptions = {},
): Promise<ProductCategorySummary[]> {
  try {
    return await getProductCategories(options);
  } catch (error) {
    logger.error("[ProductCategories] Rendering without categories after fetch failure", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function getNavbarProductCategories(
  options: Pick<FetchProductCategoriesOptions, "includeChildren" | "cache" | "revalidate"> = {},
): Promise<ProductCategorySummary[]> {
  const isServerSide = typeof window === "undefined";
  const params = new URLSearchParams();
  params.append("populate[product_categories][fields][0]", "Title");
  params.append("populate[product_categories][fields][1]", "Slug");
  params.append("populate[product_categories][fields][2]", "isMainCategory");
  params.append("populate[product_categories][fields][3]", "featured");
  params.append("populate[product_categories][fields][4]", "homepageOrder");
  params.append("populate[product_categories][populate][0]", "Image");
  params.append("populate[product_categories][populate][1]", "MegaMenuImage");
  params.append("populate[product_categories][populate][2]", "parent");
  if (options.includeChildren) {
    params.append("populate[product_categories][populate][3]", "children");
  }
  if (!isServerSide) {
    params.append("_skip_global_loader", "1");
  }

  const baseUrl = isServerSide ? getStrapiServerUrl() : API_BASE_URL;
  const url = `${baseUrl}/navigation?${params.toString()}`;
  const useCacheable =
    isServerSide && typeof options.revalidate === "number" && options.cache !== "no-store";

  const requestInit: RequestInit & { next?: { revalidate: number } } = {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Encoding": "gzip",
    },
    cache: useCacheable ? "default" : (options.cache ?? "no-store"),
  };

  // A cached storefront route normally shields this request. Keep the cold-cache
  // path bounded too: if Strapi is saturated, one cache fill must not leave a
  // Next.js worker waiting indefinitely.
  if (isServerSide) {
    requestInit.signal = AbortSignal.timeout(CHECKOUT_REQUEST_TIMEOUT_MS);
  }

  if (isServerSide && typeof options.revalidate === "number") {
    requestInit.next = { revalidate: options.revalidate };
  }

  try {
    const response = isServerSide
      ? await fetch(url, requestInit)
      : await fetchWithTimeout(url, {
          ...requestInit,
          timeoutMs: CHECKOUT_REQUEST_TIMEOUT_MS,
        });

    if (!response.ok) {
      if (isServerSide) {
        logger.error("[NavbarCategories] Failed to fetch navigation categories", {
          status: response.status,
          statusText: response.statusText,
          url: url.replace(baseUrl, "[BASE_URL]"),
        });
      }
      throw new CategoryFetchError(
        `Navigation category request failed with status ${response.status}`,
        response.status,
      );
    }

    const json = (await response.json()) as RawNavigationResponse;
    const items = json.data?.attributes?.product_categories?.data;
    // A successful response with no assigned categories is real, empty data.
    if (!Array.isArray(items)) return [];

    return items
      .map((item) => mapProductCategory(item, { includeChildren: options.includeChildren }))
      .filter((item): item is ProductCategorySummary => Boolean(item));
  } catch (error) {
    if (isServerSide) {
      logger.error("[NavbarCategories] Unexpected error fetching navigation categories", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error instanceof CategoryFetchError
      ? error
      : new CategoryFetchError(error instanceof Error ? error.message : String(error));
  }
}
