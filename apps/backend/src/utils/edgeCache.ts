/**
 * Invalidation for the two caches in front of the storefront.
 *
 * There are two of them and they are purged differently. The gateway's page
 * cache (L2) is refreshed *through*: a request carrying the shared secret
 * re-renders the page and overwrites the stored copy, so the entry is replaced
 * warm rather than dropped cold. ArvanCloud (L1) is purged by URL over its API.
 *
 * The order is always L2 first, then the edge — purging the edge first would
 * only make it refill from the stale origin copy it was told to drop.
 *
 * Everything here is best-effort by contract. A product must publish, an order
 * must complete, and stock must decrement whether or not a CDN answered; the
 * TTLs bound the staleness either way. Failures are reported, never thrown.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type EdgeCacheConfig = {
  enabled: boolean;
  storefrontOrigin: string;
  storefrontHost: string;
  gatewayInternalUrl: string;
  refreshSecret: string;
  arvanApiBase: string;
  arvanDomain: string;
  arvanApiKey: string;
  purgeBatch: number;
  requestTimeoutMs: number;
};

export type EdgeCacheSummary = {
  skipped?: "disabled" | "no-paths";
  paths: number;
  refreshed: number;
  refreshFailed: number;
  purged: number;
  purgeFailed: number;
};

/** Every encoding the gateway stores a page under. Warming one leaves the other cold. */
const STORED_ENCODINGS = ["br", "gzip"] as const;

function envString(env: NodeJS.ProcessEnv, key: string, fallback = ""): string {
  return (env[key] ?? "").trim() || fallback;
}

export function loadEdgeCacheConfig(env: NodeJS.ProcessEnv = process.env): EdgeCacheConfig {
  const storefrontOrigin = envString(
    env,
    "STOREFRONT_PUBLIC_ORIGIN",
    "https://new.infinitycolor.co",
  ).replace(/\/$/, "");

  let storefrontHost = "";
  try {
    storefrontHost = new URL(storefrontOrigin).host;
  } catch {
    storefrontHost = "";
  }

  const purgeBatch = Number(envString(env, "ARVAN_PURGE_BATCH", "30"));
  const requestTimeoutMs = Number(envString(env, "EDGE_REQUEST_TIMEOUT_MS", "20000"));

  return {
    enabled: envString(env, "EDGE_PURGE_ENABLED") === "true",
    storefrontOrigin,
    storefrontHost,
    gatewayInternalUrl: envString(env, "GATEWAY_INTERNAL_URL", "http://gateway:8080").replace(
      /\/$/,
      "",
    ),
    refreshSecret: envString(env, "L2_REFRESH_SECRET"),
    arvanApiBase: envString(env, "ARVAN_API_BASE", "https://napi.arvancloud.ir").replace(/\/$/, ""),
    arvanDomain: envString(env, "ARVAN_CDN_DOMAIN", "infinitycolor.co"),
    arvanApiKey: envString(env, "ARVAN_CDN_API_KEY"),
    purgeBatch: Number.isFinite(purgeBatch) && purgeBatch > 0 ? Math.floor(purgeBatch) : 30,
    requestTimeoutMs:
      Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 20_000,
  };
}

/**
 * Percent-encode a path the way a browser would.
 *
 * Slugs are stored as raw UTF-8 and 1,642 of 3,442 of them are non-ASCII, but a
 * browser always sends the encoded form and the gateway keys on `$request_uri`,
 * which preserves exactly what arrived. Refreshing with the raw bytes would
 * write a cache entry under a key no visitor will ever request: the purge would
 * report success and the stale page would keep being served.
 */
export function encodeStorefrontPath(path: string): string {
  const [rawPath, ...rest] = path.split("?");
  const encodedPath = rawPath
    .split("/")
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/");
  return rest.length > 0 ? `${encodedPath}?${rest.join("?")}` : encodedPath;
}

function normalizePaths(paths: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const raw of paths) {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) continue;
    const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    seen.add(encodeStorefrontPath(withSlash));
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Which URLs an event invalidates.
//
// Kept here rather than in each lifecycle so that "a price changed" has one
// answer, and so the PLP pages a product appears on cannot drift out of sync
// with the PDP.
// ---------------------------------------------------------------------------

export function buildProductPaths(input: {
  slug?: string | null;
  previousSlug?: string | null;
  categorySlugs?: (string | null | undefined)[];
}): string[] {
  const paths: string[] = ["/", "/plp", "/sitemap.xml"];

  for (const slug of [input.slug, input.previousSlug]) {
    const value = (slug ?? "").trim();
    // A renamed product invalidates both names: the old one now redirects or
    // 404s, and a cache still holding its 200 would keep serving a page that no
    // longer exists.
    if (value) paths.push(`/pdp/${value}`);
  }

  for (const category of input.categorySlugs ?? []) {
    const value = (category ?? "").trim();
    if (value) paths.push(`/plp/category/${value}`);
  }

  return normalizePaths(paths);
}

export function buildCategoryPaths(slug?: string | null): string[] {
  const value = (slug ?? "").trim();
  return normalizePaths(["/plp", value ? `/plp/category/${value}` : "", "/"]);
}

export function buildBlogPaths(slug?: string | null): string[] {
  const value = (slug ?? "").trim();
  return normalizePaths([value ? `/${value}` : "", "/blog", "/blog/feed.xml", "/sitemap.xml"]);
}

export function buildHomePaths(): string[] {
  return normalizePaths(["/", "/plp"]);
}

/** Layout-level content: identity, navigation, footer, settings. */
export function buildSiteWidePaths(): string[] {
  return normalizePaths(["/", "/plp", "/blog", "/faq", "/about", "/contact", "/returns", "/terms"]);
}

// ---------------------------------------------------------------------------
// Doing the work
// ---------------------------------------------------------------------------

/**
 * Deliberately `node:http` and not `fetch`.
 *
 * `Host` is a forbidden header in the Fetch spec, and Node's `fetch` silently
 * drops it and substitutes the one from the URL — verified on node v22: a
 * request to `http://gateway:8080/` carrying `Host: new.infinitycolor.co`
 * arrives with `host: gateway:8080`. The gateway routes by Host and its
 * `default_server` answers `444`, so every single refresh would fail while
 * looking like an ordinary connection error. `http.request` sends the header
 * as given.
 */
function refreshOne(path: string, encoding: string, config: EdgeCacheConfig): Promise<boolean> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(config.gatewayInternalUrl);
    } catch {
      resolve(false);
      return;
    }

    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = transport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path,
        method: "GET",
        headers: {
          // The gateway routes on Host, and forwards X-Forwarded-Proto as
          // received -- without the latter Next renders the page under `http`
          // and stores a representation real traffic never requests.
          Host: config.storefrontHost,
          "X-Forwarded-Proto": "https",
          "Accept-Encoding": encoding,
          "X-Infinity-Refresh": config.refreshSecret,
        },
        timeout: config.requestTimeoutMs,
      },
      (response) => {
        // A 404 is a legitimate outcome: an unpublished product has to replace
        // its stored 200 with the 404 the page now returns.
        const ok = (response.statusCode ?? 500) < 500;
        // Drain, or the socket is never released back to the agent.
        response.resume();
        response.on("end", () => finish(ok));
        response.on("error", () => finish(false));
      },
    );

    request.on("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.on("error", () => finish(false));
    request.end();
  });
}

async function purgeBatch(urls: string[], config: EdgeCacheConfig): Promise<boolean> {
  try {
    const response = await fetch(
      `${config.arvanApiBase}/cdn/4.0/domains/${config.arvanDomain}/caching/purge`,
      {
        method: "POST",
        headers: {
          Authorization: `Apikey ${config.arvanApiKey}`,
          "Content-Type": "application/json",
        },
        // Never "all": that would drop every static chunk and all 8.9 GB of
        // uploads along with the pages, and refilling those from origin is far
        // worse than a briefly stale page.
        body: JSON.stringify({ purge: "individual", purge_urls: urls }),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function invalidatePaths(
  rawPaths: string[],
  options: { config?: EdgeCacheConfig; logPrefix?: string; strapi?: any } = {},
): Promise<EdgeCacheSummary> {
  const config = options.config ?? loadEdgeCacheConfig();
  const logPrefix = options.logPrefix ?? "edge-cache";
  // The worker receives strapi as a parameter rather than relying on the global.
  const log = options.strapi?.log ?? (globalThis as any).strapi?.log;
  const paths = normalizePaths(rawPaths);

  const empty: EdgeCacheSummary = {
    paths: paths.length,
    refreshed: 0,
    refreshFailed: 0,
    purged: 0,
    purgeFailed: 0,
  };

  if (!config.enabled) return { ...empty, skipped: "disabled" };
  if (paths.length === 0) return { ...empty, skipped: "no-paths" };

  let refreshed = 0;
  let refreshFailed = 0;

  if (config.refreshSecret) {
    const results = await Promise.all(
      paths.flatMap((path) =>
        STORED_ENCODINGS.map((encoding) => refreshOne(path, encoding, config)),
      ),
    );
    refreshed = results.filter(Boolean).length;
    refreshFailed = results.length - refreshed;
  } else {
    log?.warn?.(`[${logPrefix}] L2_REFRESH_SECRET is unset; purging the edge without warming`);
  }

  let purged = 0;
  let purgeFailed = 0;

  if (config.arvanApiKey) {
    for (const batch of chunk(paths, config.purgeBatch)) {
      const urls = batch.map((path) => `${config.storefrontOrigin}${path}`);
      if (await purgeBatch(urls, config)) purged += batch.length;
      else purgeFailed += batch.length;
    }
  } else {
    log?.warn?.(`[${logPrefix}] ARVAN_CDN_API_KEY is unset; the edge was not purged`);
    purgeFailed = paths.length;
  }

  const summary: EdgeCacheSummary = {
    paths: paths.length,
    refreshed,
    refreshFailed,
    purged,
    purgeFailed,
  };

  if (refreshFailed > 0 || purgeFailed > 0) {
    log?.warn?.(`[${logPrefix}] ${JSON.stringify(summary)}`);
  } else {
    log?.info?.(`[${logPrefix}] ${JSON.stringify(summary)}`);
  }

  return summary;
}
