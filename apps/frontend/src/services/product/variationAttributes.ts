import {
  API_BASE_URL,
  CHECKOUT_REQUEST_TIMEOUT_MS,
  ENDPOINTS,
  getStrapiServerUrl,
} from "@/constants/api";
import { PRODUCT_COLLECTION_TAG, PRODUCT_TAG } from "@/constants/cacheTags";
import fetchWithTimeout from "@/utils/fetchWithTimeout";
import logger from "@/utils/logger";
import type { CatalogColor } from "@/utils/plpColorFilter";

export interface VariationSizeRecord {
  title: string;
}

interface StrapiEntity {
  id?: number;
  attributes?: {
    Title?: string;
    ColorCode?: string | null;
  };
  Title?: string;
  ColorCode?: string | null;
}

interface StrapiListResponse {
  data?: StrapiEntity[];
  meta?: {
    pagination?: {
      page?: number;
      pageCount?: number;
    };
  };
}

const PAGE_SIZE = 200;
const MAX_PAGES = 8;

function readTitle(entity: StrapiEntity): string | null {
  const title = entity.attributes?.Title ?? entity.Title;
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readColorCode(entity: StrapiEntity): string | null {
  const code = entity.attributes?.ColorCode ?? entity.ColorCode;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

async function fetchCollectionPages(path: string, revalidate?: number): Promise<StrapiEntity[]> {
  const isServerSide = typeof window === "undefined";
  const baseUrl = isServerSide ? getStrapiServerUrl() : API_BASE_URL;
  const items: StrapiEntity[] = [];

  for (let page = 1, pageCount = 1; page <= pageCount && page <= MAX_PAGES; page += 1) {
    const params = new URLSearchParams();
    params.set("pagination[page]", String(page));
    params.set("pagination[pageSize]", String(PAGE_SIZE));
    params.set("sort", "Title:asc");
    if (!isServerSide) params.set("_skip_global_loader", "1");

    const url = `${baseUrl}${path}?${params.toString()}`;
    const init: RequestInit & { next?: { revalidate: number; tags: string[] } } = {
      headers: {
        Accept: "application/json",
      },
    };
    if (isServerSide && typeof revalidate === "number") {
      init.next = { revalidate, tags: [PRODUCT_TAG, PRODUCT_COLLECTION_TAG] };
    }

    const response = isServerSide
      ? await fetch(url, init)
      : await fetchWithTimeout(url, { ...init, timeoutMs: CHECKOUT_REQUEST_TIMEOUT_MS });

    if (!response.ok) {
      throw new Error(`Variation attribute request failed with status ${response.status}`);
    }

    const json = (await response.json()) as StrapiListResponse;
    const pageItems = Array.isArray(json.data) ? json.data : [];
    items.push(...pageItems);
    const nextPageCount = Number(json.meta?.pagination?.pageCount);
    pageCount = Number.isFinite(nextPageCount) && nextPageCount > 0 ? nextPageCount : page;
  }

  return items;
}

export async function getProductVariationSizes(
  options: { revalidate?: number } = {},
): Promise<VariationSizeRecord[]> {
  try {
    const items = await fetchCollectionPages(ENDPOINTS.PRODUCT.SIZES, options.revalidate);
    const titles = items
      .map(readTitle)
      .filter((title): title is string => Boolean(title));
    return [...new Map(titles.map((title) => [title, { title }])).values()];
  } catch (error) {
    logger.error("[PLP] Failed to load variation sizes", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function getProductVariationColors(
  options: { revalidate?: number } = {},
): Promise<CatalogColor[]> {
  try {
    const items = await fetchCollectionPages(ENDPOINTS.PRODUCT.COLORS, options.revalidate);
    const colors: CatalogColor[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const title = readTitle(item);
      if (!title || seen.has(title)) continue;
      seen.add(title);
      colors.push({ title, colorCode: readColorCode(item) });
    }
    return colors;
  } catch (error) {
    logger.error("[PLP] Failed to load variation colors", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
