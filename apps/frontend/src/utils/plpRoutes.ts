type QuerySource =
  | URLSearchParams
  | {
      forEach: (callback: (value: string, key: string) => void) => void;
    };

function normalizeCategorySlug(slug: string | null | undefined) {
  const normalized = slug?.trim().replace(/\/+$/, "") || "";
  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
}

function cloneSearchParams(source?: QuerySource | null) {
  const params = new URLSearchParams();
  source?.forEach((value, key) => {
    params.append(key, value);
  });
  return params;
}

function appendQuery(pathname: string, params: URLSearchParams) {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function getCategoryPlpHref(slug: string | null | undefined) {
  const normalized = normalizeCategorySlug(slug);
  return normalized ? `/plp/category/${encodeURIComponent(normalized)}` : "/plp";
}

export function getPlpHref(source?: QuerySource | null, options: { resetPage?: boolean } = {}) {
  const params = cloneSearchParams(source);
  params.delete("category");
  if (options.resetPage !== false) {
    params.delete("page");
  }
  return appendQuery("/plp", params);
}

export function getCategoryPlpHrefWithQuery(
  slug: string | null | undefined,
  source?: QuerySource | null,
  options: { resetPage?: boolean } = {},
) {
  const params = cloneSearchParams(source);
  params.delete("category");
  if (options.resetPage !== false) {
    params.delete("page");
  }
  return appendQuery(getCategoryPlpHref(slug), params);
}

type SearchLookup = Pick<URLSearchParams, "get"> | string | null | undefined;

function decodePathname(path: string) {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function lookupSearchParam(search: SearchLookup, key: string) {
  if (!search) return null;
  if (typeof search === "string") {
    return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get(key);
  }
  return search.get(key);
}

/**
 * Nav items that share `/plp` but carry different queries (Oppsi, discounts)
 * must not all light up on a bare product list.
 */
export function isActiveNavHref(
  href: string,
  pathname: string,
  search: SearchLookup = "",
): boolean {
  if (href === "/") return pathname === "/";

  const queryIndex = href.indexOf("?");
  const hrefPath = queryIndex >= 0 ? href.slice(0, queryIndex) : href;
  const hrefQuery = queryIndex >= 0 ? href.slice(queryIndex + 1) : "";

  if (decodePathname(pathname) !== decodePathname(hrefPath)) return false;

  const required = new URLSearchParams(hrefQuery);
  const requiredEntries = [...required.entries()];
  if (requiredEntries.length === 0) return true;

  return requiredEntries.every(([key, value]) => lookupSearchParam(search, key) === value);
}
