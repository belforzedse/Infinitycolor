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
  data?: { id: number }[] | null;
}

interface RawProductCategory {
  id: number;
  attributes?: {
    Title?: string;
    Slug?: string;
    isMainCategory?: boolean | null;
    featured?: boolean | null;
    Image?: CategoryImageField | null;
    parent?: CategoryRelation | null;
    children?: ChildrenRelation | null;
  };
  Title?: string;
  Slug?: string;
  Color?: string | null;
  isMainCategory?: boolean | null;
  featured?: boolean | null;
  Image?: CategoryImageField | null;
  parent?: CategoryRelation | null;
  children?: ChildrenRelation | null;
}

export interface ProductCategorySummary {
  id: number;
  name: string;
  slug: string;
  imageUrl: string | null;
  imageAlt: string;
  imageWidth?: number | null;
  imageHeight?: number | null;
  parentId: number | null;
  isMainCategory: boolean;
  /** True when category has at least one child (only set when children were populated). */
  hasChildren?: boolean;
  /** True when category is marked as featured in Strapi (for carousel / bottom nav). */
  featured?: boolean;
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
   * When provided, only return categories whose name includes at least one of these substrings.
   * Fallback when featured is not used; used for homepage carousel and bottom nav category sheet.
   */
  allowedNameSubstrings?: readonly string[];
  limit?: number;
  sort?: string;
  cache?: RequestCache;
  revalidate?: number;
}

const SERVER_CATEGORY_PAGE_SIZE = 100;
const SERVER_CATEGORY_MAX_PAGES = 50;

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
  params.set("sort", options.sort || "Title:asc");
  params.append("fields[0]", "Title");
  params.append("fields[1]", "Slug");
  params.append("fields[2]", "isMainCategory");
  params.append("fields[3]", "featured");
  params.append("populate[0]", "Image");
  params.append("populate[1]", "parent");

  const parentOnly = options.parentOnly || options.parentsWithChildrenOnly || options.mainOnly;
  if (parentOnly) {
    params.append("filters[parent][id][$null]", "true");
  }
  if (options.mainOnly) {
    params.append("filters[isMainCategory][$eq]", "true");
  }
  if (options.parentsWithChildrenOnly) {
    params.append("populate[2]", "children");
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
        return null;
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
        if (!json) return [];

        const pageItems: RawProductCategory[] = Array.isArray(json?.data) ? json.data : [];
        items = items.concat(pageItems);

        const pagination = json?.meta?.pagination;
        const nextPageCount = Number(pagination?.pageCount);
        pageCount = Number.isFinite(nextPageCount) && nextPageCount > 0 ? nextPageCount : page;
      }
    } else {
      const json = await fetchCategoryJson();
      if (!json) return [];
      items = Array.isArray(json?.data) ? json.data : [];
    }

    const mapped = items
      .map((item) => {
        const attrs = item.attributes || item;
        const name = attrs.Title || attrs.Slug || String(item.id);
        const slug = attrs.Slug || String(item.id);
        const parentId = attrs.parent?.data?.id ?? null;
        const isMainCategory = Boolean(attrs.isMainCategory);
        const image = resolveCategoryImage(attrs.Image);
        const childrenData = attrs.children?.data ?? item.children?.data;
        const hasChildren = Array.isArray(childrenData) && childrenData.length > 0;

        return {
          id: item.id,
          name,
          slug,
          imageUrl: image.url,
          imageAlt: image.alt || name,
          imageWidth: image.width,
          imageHeight: image.height,
          parentId,
          isMainCategory,
          hasChildren: options.parentsWithChildrenOnly ? hasChildren : undefined,
          featured: Boolean(attrs.featured),
        } as ProductCategorySummary;
      })
      .filter((item) => item.slug);

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
    return [];
  }
}
