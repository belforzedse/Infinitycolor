import { ENDPOINTS } from "@/constants/api";
import { apiClient } from "@/services";

/**
 * Server-side search for the variation-axis pickers (colours, sizes, models, and
 * a generic attribute's terms).
 *
 * These endpoints used to be prefetched whole with `pagination[pageSize]=1000`
 * and filtered in the browser. `apps/backend/config/api.ts` caps `rest.maxLimit`
 * at 100, so that prefetch silently returned only the alphabetically-first 100
 * rows — every colour after that was unfindable. Searching server-side removes
 * the ceiling instead of raising it (the cap also protects public endpoints).
 */

/** A single selectable option, normalised out of either Strapi response shape. */
export type VariationOption = {
  id: string;
  title: string;
  colorCode?: string;
};

/** Comfortably under the backend's maxLimit of 100, so nothing is clamped away. */
const SEARCH_PAGE_SIZE = 20;

type StrapiRow = {
  id?: number | string;
  attributes?: { Title?: string; ColorCode?: string | null };
  Title?: string;
  ColorCode?: string | null;
};

/** Strapi v4 nests under `attributes`; some populated shapes come back flat. */
function toOption(row: StrapiRow): VariationOption | null {
  const id = row?.id;
  const title = row?.attributes?.Title ?? row?.Title;
  if (id === undefined || id === null || !title) return null;
  const colorCode = row?.attributes?.ColorCode ?? row?.ColorCode;
  return {
    id: String(id),
    title: String(title),
    ...(colorCode ? { colorCode: String(colorCode) } : {}),
  };
}

async function fetchOptions(url: string): Promise<VariationOption[]> {
  // Deliberately no `cache: "no-store"`: that appends a cache-buster and bypasses
  // the 60s colour/size/model cache in lib/api-cache.ts. Cache keys include the
  // query string, so each distinct search caches on its own, and the colour
  // management page already invalidates the pattern after any write.
  const response = await apiClient.get<StrapiRow[]>(url);
  const rows = Array.isArray((response as any)?.data) ? (response as any).data : [];
  return rows
    .map((row: StrapiRow) => toOption(row))
    .filter((option: VariationOption | null): option is VariationOption =>
      Boolean(option),
    );
}

/**
 * Encodes a user-typed query for use in a filter value.
 *
 * `encodeURIComponent` matters more than usual here: a colour-code search starts
 * with `#`, which unencoded would be read as the URL fragment and leave the
 * server with an empty filter value.
 */
const filterValue = (query: string) => encodeURIComponent(query.trim());

/** Matches Title or ColorCode, preserving what the old client-side filter did. */
export async function searchColors(query: string): Promise<VariationOption[]> {
  const q = filterValue(query);
  return fetchOptions(
    `${ENDPOINTS.PRODUCT.COLORS}?filters[$or][0][Title][$containsi]=${q}` +
      `&filters[$or][1][ColorCode][$containsi]=${q}` +
      `&pagination[pageSize]=${SEARCH_PAGE_SIZE}&sort=Title:asc`,
  );
}

export async function searchSizes(query: string): Promise<VariationOption[]> {
  return fetchOptions(
    `${ENDPOINTS.PRODUCT.SIZES}?filters[Title][$containsi]=${filterValue(query)}` +
      `&pagination[pageSize]=${SEARCH_PAGE_SIZE}&sort=Title:asc`,
  );
}

export async function searchModels(query: string): Promise<VariationOption[]> {
  return fetchOptions(
    `${ENDPOINTS.PRODUCT.MODELS}?filters[Title][$containsi]=${filterValue(query)}` +
      `&pagination[pageSize]=${SEARCH_PAGE_SIZE}&sort=Title:asc`,
  );
}

/**
 * Terms belonging to one generic attribute definition.
 *
 * Curried so a row can hold a stable search function: the picker keeps `search`
 * in an effect dependency list, so a fresh closure on every parent render would
 * refire the request. Memoise the result per attribute id at the call site.
 */
export function searchAttributeTerms(attributeId: number) {
  return async (query: string): Promise<VariationOption[]> =>
    fetchOptions(
      `${ENDPOINTS.PRODUCT.ATTRIBUTE_TERMS}?filters[product_attribute][id][$eq]=${attributeId}` +
        `&filters[Title][$containsi]=${filterValue(query)}` +
        `&pagination[pageSize]=${SEARCH_PAGE_SIZE}&sort[0]=Position:asc&sort[1]=Title:asc`,
    );
}
