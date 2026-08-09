/**
 * Single source of truth for "every currently published, PDP-eligible product."
 *
 * generateStaticParams (build-time SSG) and sitemap.ts (runtime) used to run two
 * independent Strapi pagination loops. One of them (generateStaticParams) wasn't
 * really paginating at all — it fetched a single page sorted two different ways
 * and capped the result at 200 products, so most of the catalog was never
 * statically generated. Routing through one enumerator means both call sites see
 * the same complete, deterministically-ordered catalog and can't silently drift.
 */
import { ENDPOINTS, getStrapiServerUrl, RETRY_CONFIG } from "@/constants/api";
import logger from "@/utils/logger";

export interface PdpEligibleProduct {
  id: number;
  slug: string;
  status: string;
  updatedAt: string;
}

interface StrapiListResponse {
  data?: Array<{
    id: number;
    attributes?: { Slug?: string; Status?: string; updatedAt?: string };
  }>;
  meta?: { pagination?: { pageCount?: number } };
}

const PAGE_SIZE = 100; // Strapi's own configured maxLimit (config/api.ts) — asking for more is silently clamped.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A slug that can't survive as a single Next.js dynamic route segment: empty,
 * containing a path separator, or carrying a literal (non-percent-encoded) "%"
 * that would throw when something downstream (route matching, cache tags)
 * eventually calls decodeURIComponent on it.
 */
function isRoutableSlug(slug: unknown): slug is string {
  if (typeof slug !== "string") return false;
  const trimmed = slug.trim();
  if (trimmed.length === 0 || trimmed.includes("/")) return false;
  try {
    decodeURIComponent(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch one Strapi products page, retrying transient failures with the same
 * backoff schedule as the app's axios ApiClient (RETRY_CONFIG). A non-retryable
 * status (e.g. a genuine 400) or retry exhaustion throws — callers decide
 * whether that should fail loud (build) or degrade to an empty result (runtime
 * sitemap), it is never silently swallowed here.
 */
async function fetchPageWithRetry(url: string, tags?: string[]): Promise<StrapiListResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        next: tags?.length ? { revalidate: 3600, tags } : { revalidate: 3600 },
        headers: { "Content-Type": "application/json", Accept: "application/json" },
      });
    } catch (networkError) {
      lastError = networkError;
      if (attempt < RETRY_CONFIG.maxRetries) {
        await sleep(Math.min(RETRY_CONFIG.baseDelay * 2 ** attempt, RETRY_CONFIG.maxDelay));
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      return (await response.json()) as StrapiListResponse;
    }

    const retryable = (RETRY_CONFIG.retryableStatusCodes as readonly number[]).includes(
      response.status,
    );
    lastError = new Error(`Strapi returned ${response.status} for ${url}`);
    if (!retryable || attempt >= RETRY_CONFIG.maxRetries) {
      throw lastError;
    }
    await sleep(Math.min(RETRY_CONFIG.baseDelay * 2 ** attempt, RETRY_CONFIG.maxDelay));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Enumerate every published (Status=Active, not soft-removed) product by fully
 * paginating Strapi's `/products` collection — deterministic id-ascending order,
 * every page, no arbitrary cap. Throws if any page can't be fetched after
 * retries, rather than returning a silently-truncated list.
 *
 * `tags` are attached to the underlying fetch's Next.js cache tags so a caller
 * (e.g. the sitemap route) can be invalidated on demand; omit for build-time
 * callers where post-build revalidation doesn't apply.
 */
export async function fetchAllPdpEligibleProducts(
  options: { tags?: string[] } = {},
): Promise<PdpEligibleProduct[]> {
  const strapiBaseUrl = getStrapiServerUrl();
  const seenIds = new Set<number>();
  const raw: PdpEligibleProduct[] = [];
  let malformedSlugsExcluded = 0;
  let page = 1;
  let pageCount = 1;

  do {
    const endpoint =
      `${ENDPOINTS.PRODUCT.PRODUCT}?` +
      `filters[Status][$eq]=Active&` +
      `filters[removedAt][$null]=true&` +
      `sort[0]=id:asc&` +
      `pagination[page]=${page}&` +
      `pagination[pageSize]=${PAGE_SIZE}&` +
      `fields[0]=Slug&fields[1]=Status&fields[2]=updatedAt`;

    const response = await fetchPageWithRetry(`${strapiBaseUrl}${endpoint}`, options.tags);
    const rows = response?.data || [];

    for (const row of rows) {
      if (!row?.id || seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      const slug = row.attributes?.Slug;
      if (!isRoutableSlug(slug)) {
        malformedSlugsExcluded += 1;
        logger.warn(`[Catalog] Excluding product with unroutable slug`, {
          productId: row.id,
          slug,
        });
        continue;
      }
      raw.push({
        id: row.id,
        slug,
        status: row.attributes?.Status || "Active",
        updatedAt: row.attributes?.updatedAt || new Date(0).toISOString(),
      });
    }

    pageCount = response?.meta?.pagination?.pageCount || 1;
    page += 1;
  } while (page <= pageCount);

  // Dedupe by canonical slug. Rows arrive id-ascending, so the first occurrence
  // of a slug is deterministically the lowest id — never let a later duplicate
  // silently overwrite it in a Map.
  const bySlug = new Map<string, PdpEligibleProduct>();
  let duplicateSlugsExcluded = 0;
  for (const product of raw) {
    if (bySlug.has(product.slug)) {
      duplicateSlugsExcluded += 1;
      logger.warn(`[Catalog] Duplicate canonical slug excluded`, {
        slug: product.slug,
        keptProductId: bySlug.get(product.slug)?.id,
        excludedProductId: product.id,
      });
      continue;
    }
    bySlug.set(product.slug, product);
  }

  const products = Array.from(bySlug.values());
  logger.info(`[Catalog] Enumerated PDP-eligible products`, {
    fetched: raw.length + malformedSlugsExcluded,
    eligible: products.length,
    duplicateSlugsExcluded,
    malformedSlugsExcluded,
  });
  return products;
}

/**
 * PDP static-generation eligibility. Currently identical to the full eligible
 * set (no draft/removed rows ever reach `fetchAllPdpEligibleProducts`), kept as
 * its own named export so a future "unlisted but still routable" rule doesn't
 * require re-plumbing the fetch.
 */
export function getPdpStaticParamsProducts(products: PdpEligibleProduct[]): PdpEligibleProduct[] {
  return products;
}

/**
 * Sitemap/SEO indexability. Currently identical to PDP eligibility — there is no
 * noindex/canonical-alias flag on the product schema yet. Kept separate from
 * `getPdpStaticParamsProducts` so that when one is added, only this filter
 * changes and PDP routing/static generation stay unaffected.
 */
export function getSitemapEligibleProducts(products: PdpEligibleProduct[]): PdpEligibleProduct[] {
  return products;
}
