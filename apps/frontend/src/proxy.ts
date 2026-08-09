import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSecurityHeaderEntries } from "./utils/securityHeaders";
import { AUTH_ROUTE_HINT_COOKIE, AUTH_ROUTE_HINT_COOKIE_VALUE } from "./utils/authRouteHint";
import { isAuthRequiredRoute, isPrivateRoute } from "./utils/routeAccessPolicy";
import { exactCentralAuthOrigin } from "./lib/central-auth-origin";
import { SITE_URL } from "./config/site";

export { isAuthRequiredRoute };

export const LEGACY_REDIRECT_STATUS = 301;
export const AUTH_REDIRECT_STATUS = 307;
export const ADMIN_CUTOVER_REDIRECT_STATUS = 307;

const ADMIN_ORIGINS = {
  production: "https://admin.infinitycolor.co",
  staging: "https://admin.staging.infinitycolor.co",
} as const;

const PDP_REDIRECT_TIMEOUT_MS = 1500;
const WOO_VARIATION_PARAM_NAMES = new Set(["رنگ", "سایز", "طرح"]);
const RETIRED_LEGACY_PATHS = new Set(["/offer/best-sellers", "/offer/week-style"]);
const SECURITY_RESPONSE_HEADERS = [
  ["X-DNS-Prefetch-Control", "on"],
  ...getSecurityHeaderEntries(),
] as const;
type LegacyRedirectSourceUrl = Pick<URL, "href" | "pathname" | "search" | "searchParams">;

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function stripTrailingSlash(pathname: string) {
  if (pathname === "/") {
    return pathname;
  }

  return pathname.replace(/\/+$/, "") || "/";
}

export function getSegments(pathname: string) {
  return stripTrailingSlash(pathname)
    .split("/")
    .filter(Boolean)
    .map((segment) => safeDecodeURIComponent(segment));
}

function getDecodedPathname(pathname: string) {
  const segments = getSegments(pathname);
  return segments.length > 0 ? `/${segments.join("/")}` : "/";
}

function isLoopbackAdminOrigin(origin: string) {
  const hostname = new URL(origin).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function fixedAdminCutoverOrigin() {
  const environment = process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT;
  if (environment === "production" || environment === "staging") {
    return ADMIN_ORIGINS[environment];
  }
  const configured = process.env.ADMIN_REDIRECT_LOCAL_ORIGIN?.trim();
  if (!configured) return "http://localhost:2891";
  const parsed = new URL(configured);
  if (parsed.origin !== configured || !isLoopbackAdminOrigin(parsed.origin)) {
    throw new Error("ADMIN_REDIRECT_LOCAL_ORIGIN must be an exact loopback origin");
  }
  return parsed.origin;
}

export function isLegacyAdminPath(pathname: string) {
  return pathname === "/super-admin" || pathname.startsWith("/super-admin/");
}

export function getAdminCutoverRedirectUrl(sourceUrl: LegacyRedirectSourceUrl) {
  if (!isLegacyAdminPath(sourceUrl.pathname)) return null;
  const suffix = sourceUrl.pathname.slice("/super-admin".length);
  const reportDestinations = new Map<string, string>([
    ["/reports", "/sales"],
    ["/reports/traffic", "/sales/traffic"],
    ["/reports/funnel", "/sales/traffic"],
    ["/reports/product-sales", "/sales/products"],
    ["/reports/geography", "/sales/breakdown"],
    ["/reports/liquidity", "/sales/liquidity"],
    ["/reports/gateway-liquidity", "/sales/liquidity"],
    ["/reports/admin-activity", "/settings/activity"],
  ]);
  const normalizedSuffix = stripTrailingSlash(suffix || "/");
  const activityDetail = normalizedSuffix.match(/^\/reports\/admin-activity\/(.+)$/);
  const destination = activityDetail
    ? `/settings/activity/${activityDetail[1]}`
    : reportDestinations.get(normalizedSuffix) || suffix || "/";
  const params = new URLSearchParams(sourceUrl.searchParams);
  if (normalizedSuffix === "/reports/traffic" || normalizedSuffix === "/reports/funnel") {
    if (params.has("from") && !params.has("start")) params.set("start", params.get("from") || "");
    if (params.has("to") && !params.has("end")) params.set("end", params.get("to") || "");
    params.delete("from");
    params.delete("to");
    for (const [legacy, current] of [
      ["utm_source", "utmSource"],
      ["utm_medium", "utmMedium"],
      ["utm_campaign", "utmCampaign"],
      ["utm_content", "utmContent"],
      ["utm_term", "utmTerm"],
    ] as const) {
      if (params.has(legacy) && !params.has(current)) {
        params.set(current, params.get(legacy) || "");
      }
      params.delete(legacy);
    }
    const legacyView = params.get("tab");
    const viewMap = new Map([
      ["overview", "overview"],
      ["acquisition", "acquisition"],
      ["content", "content"],
      ["audience", "audience"],
      ["engagement", "content"],
      ["ecommerce", "conversion"],
      ["health", "overview"],
    ]);
    params.set(
      "view",
      normalizedSuffix === "/reports/funnel"
        ? "conversion"
        : viewMap.get(legacyView || "") || "overview",
    );
    params.delete("tab");
  } else if (normalizedSuffix === "/reports/geography") {
    params.set("tab", "geography");
  } else if (normalizedSuffix === "/reports/gateway-liquidity") {
    params.set("section", "gateways");
  }
  const target = new URL(destination, fixedAdminCutoverOrigin());
  target.search = params.toString();
  return target;
}

export function lastCategorySegmentFromShopPath(segments: string[]) {
  const pathSegments = segments[0] === "shop" ? segments.slice(1) : segments;
  const pageIndex = pathSegments.lastIndexOf("page");
  const categorySegments = pageIndex >= 0 ? pathSegments.slice(0, pageIndex) : pathSegments;

  return categorySegments.length > 0 ? categorySegments[categorySegments.length - 1] : null;
}

function buildRedirectUrl(
  sourceUrl: LegacyRedirectSourceUrl,
  pathname: string,
  searchParams?: URLSearchParams,
) {
  const url = new URL(sourceUrl.href);
  url.pathname = pathname;
  url.search = searchParams?.toString() ? `?${searchParams.toString()}` : "";

  return url;
}

export function redirectTo(request: NextRequest, pathname: string, searchParams?: URLSearchParams) {
  return buildRedirectUrl(request.nextUrl, pathname, searchParams);
}

export function isWooVariationParam(name: string) {
  return name.startsWith("pa_") || WOO_VARIATION_PARAM_NAMES.has(name);
}

export function hasWooVariationParams(searchParams: URLSearchParams) {
  return Array.from(searchParams.keys()).some(isWooVariationParam);
}

function encodePathSegment(segment: string) {
  return encodeURIComponent(segment);
}

function redirectIfChanged(
  sourceUrl: LegacyRedirectSourceUrl,
  pathname: string,
  searchParams?: URLSearchParams,
) {
  const target = buildRedirectUrl(sourceUrl, pathname, searchParams);

  if (target.pathname === sourceUrl.pathname && target.search === sourceUrl.search) {
    return null;
  }

  return target;
}

export function isRetiredLegacyPath(pathname: string) {
  return RETIRED_LEGACY_PATHS.has(getDecodedPathname(pathname));
}

function isWordPressInternalPath(pathname: string) {
  const decodedPathname = getDecodedPathname(pathname);

  return (
    decodedPathname === "/xmlrpc.php" ||
    decodedPathname.startsWith("/wp-json") ||
    decodedPathname.startsWith("/wp-content") ||
    decodedPathname.startsWith("/wp-includes")
  );
}

export function getLegacyRedirectUrl(sourceUrl: LegacyRedirectSourceUrl) {
  const { pathname, searchParams } = sourceUrl;
  const segments = getSegments(pathname);
  const decodedPathname = getDecodedPathname(pathname);

  if (segments[0] === "product" && segments[1]) {
    return redirectIfChanged(sourceUrl, `/pdp/${encodePathSegment(segments[1])}`);
  }

  if (segments[0] === "shop") {
    const pageIndex = segments.lastIndexOf("page");
    const page = pageIndex >= 0 ? segments[pageIndex + 1] : null;
    const hasPagination = Boolean(page && /^\d+$/.test(page));
    const pageParams = new URLSearchParams();

    if (hasPagination && page) {
      pageParams.set("page", page);
    }

    if (segments.length === 1) {
      return redirectIfChanged(sourceUrl, "/plp");
    }

    if (segments[1] === "page" && hasPagination) {
      return redirectIfChanged(sourceUrl, "/plp", pageParams);
    }

    const categorySlug = lastCategorySegmentFromShopPath(segments);
    if (categorySlug) {
      return redirectIfChanged(
        sourceUrl,
        `/plp/category/${encodePathSegment(categorySlug)}`,
        hasPagination ? pageParams : undefined,
      );
    }

    return redirectIfChanged(sourceUrl, "/plp", hasPagination ? pageParams : undefined);
  }

  if (segments[0] === "category" && segments[1]) {
    const categorySlug = segments[segments.length - 1];
    const params = new URLSearchParams();
    params.set("category", categorySlug);
    return redirectIfChanged(sourceUrl, "/blog", params);
  }

  if ((segments[0] === "tag" || segments[0] === "author") && segments[1]) {
    return redirectIfChanged(sourceUrl, "/blog");
  }

  if (decodedPathname === "/offer/oppsi" || decodedPathname === "/محصولات-زده-دار") {
    const params = new URLSearchParams();
    params.set("search", "Oppsi");
    return redirectIfChanged(sourceUrl, "/plp", params);
  }

  const exactRedirects = new Map<string, string>([
    ["/سوالات-متداول", "/faq"],
    ["/شرایط-و-مقررات-تعویض-و-مرجوع", "/faq"],
    ["/my-account/orders", "/orders"],
    ["/my-account", "/account"],
    ["/user-login", "/auth"],
    ["/cart", "/cart"],
    ["/checkout", "/checkout"],
    ["/payment", "/checkout"],
    ["/sitemap_index.xml", "/sitemap.xml"],
  ]);
  const exactDestination = exactRedirects.get(decodedPathname);

  if (exactDestination) {
    return redirectIfChanged(sourceUrl, exactDestination);
  }

  if (segments[0] === "product" && segments[1] && hasWooVariationParams(searchParams)) {
    return redirectIfChanged(sourceUrl, `/pdp/${encodePathSegment(segments[1])}`);
  }

  return null;
}

function hasAuthRouteHint(request: NextRequest) {
  return request.cookies.get(AUTH_ROUTE_HINT_COOKIE)?.value === AUTH_ROUTE_HINT_COOKIE_VALUE;
}

function getAuthRedirectUrl(request: NextRequest) {
  if (process.env.CENTRAL_AUTH_CUTOVER_ENABLED === "true") {
    // Browser navigation must always use the public authority. AUTH_SERVER_ORIGIN
    // may be an internal service address and is reserved for server-to-server calls.
    const url = new URL("/auth", exactCentralAuthOrigin());
    const requestedPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    // Next's standalone server sees its loopback/container authority behind the
    // reverse proxy. Return grants must use the configured public storefront
    // authority and must never derive it from forwarded or request host data.
    url.searchParams.set("returnTo", new URL(requestedPath, SITE_URL).toString());
    return url;
  }
  const url = request.nextUrl.clone();
  const requestedPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;

  url.pathname = "/auth";
  url.search = "";
  url.searchParams.set("redirect", requestedPath);

  return url;
}

export function applySecurityHeaders(response: NextResponse) {
  for (const [key, value] of SECURITY_RESPONSE_HEADERS) {
    response.headers.set(key, value);
  }

  return response;
}

function redirectWithSecurityHeaders(url: URL, status: number) {
  return applySecurityHeaders(NextResponse.redirect(url, status));
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Security headers for SEO and performance
  const response = applySecurityHeaders(NextResponse.next());

  if (isPrivateRoute(pathname)) {
    response.headers.set("Cache-Control", "no-store, max-age=0");
  }

  // Cache control for static assets
  // Note: /_next/static and /api/ are excluded by matcher, so cache-control for those paths is handled by Next.js
  if (pathname.startsWith("/images/") || pathname.startsWith("/fonts/")) {
    response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }

  // This switch remains false through parallel validation. Cutover is an
  // explicit operational action; the destination is never request-derived.
  if (process.env.ADMIN_REDIRECT_ENABLED === "true" && isLegacyAdminPath(pathname)) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      const rejected = NextResponse.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET, HEAD" } },
      );
      rejected.headers.set("Cache-Control", "no-store, max-age=0");
      return applySecurityHeaders(rejected);
    }
    const target = getAdminCutoverRedirectUrl(request.nextUrl);
    const redirected = redirectWithSecurityHeaders(target!, ADMIN_CUTOVER_REDIRECT_STATUS);
    redirected.headers.set("Cache-Control", "no-store, max-age=0");
    return redirected;
  }

  const legacyRedirectUrl = getLegacyRedirectUrl(request.nextUrl);
  if (legacyRedirectUrl) {
    return redirectWithSecurityHeaders(legacyRedirectUrl, LEGACY_REDIRECT_STATUS);
  }

  if (isRetiredLegacyPath(pathname) || isWordPressInternalPath(pathname)) {
    return response;
  }

  // Handle trailing slashes - redirect to non-trailing slash for SEO
  if (pathname !== "/" && pathname.endsWith("/")) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.slice(0, -1);
    return redirectWithSecurityHeaders(url, LEGACY_REDIRECT_STATUS);
  }

  // This is an optimistic routing gate only. Private APIs remain responsible
  // for validating the bearer token and object-level authorization.
  if (isAuthRequiredRoute(pathname) && !hasAuthRouteHint(request)) {
    const redirectResponse = redirectWithSecurityHeaders(
      getAuthRedirectUrl(request),
      AUTH_REDIRECT_STATUS,
    );
    redirectResponse.headers.set("Cache-Control", "no-store, max-age=0");
    redirectResponse.headers.set("Vary", "Cookie");
    return redirectResponse;
  }

  // Clean up empty category parameter in PLP - redirect /plp?category= to /plp
  if (pathname === "/plp") {
    const searchParams = request.nextUrl.searchParams;
    const category = searchParams.get("category");

    // If category param exists but is empty or just whitespace, remove it
    if (category !== null && category.trim() === "") {
      const url = request.nextUrl.clone();
      url.searchParams.delete("category");
      return redirectWithSecurityHeaders(url, LEGACY_REDIRECT_STATUS); // Permanent redirect to clean URL
    }
  }

  // Redirect ID-based and non-canonical product URLs to the canonical slug.
  // Patterns:
  //   /pdp/123              → /pdp/<canonical-slug>
  //   /pdp/%d8%b3…-y00574   → /pdp/<decoded Persian slug>  (historical imports)
  if (pathname.startsWith("/pdp/")) {
    const segments = pathname.split("/");
    // Keep the raw path segment (may still contain literal %xx from old sitemaps).
    const identifier = segments[2];
    const looksNumeric = Boolean(identifier && /^\d+$/.test(identifier));
    const looksEncodedAlias = Boolean(identifier && /%[0-9A-Fa-f]{2}/.test(identifier));

    if (identifier && (looksNumeric || looksEncodedAlias)) {
      try {
        const apiBaseUrl =
          process.env.STRAPI_INTERNAL_URL ||
          process.env.NEXT_PUBLIC_API_BASE_URL ||
          "https://api.infinitycolor.co/api";
        const apiUrl = looksNumeric
          ? `${apiBaseUrl}/products/${identifier}?fields[0]=Slug`
          : `${apiBaseUrl}/products/by-slug/${encodeURIComponent(identifier)}?view=shell`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), PDP_REDIRECT_TIMEOUT_MS);

        const apiResponse = await fetch(apiUrl, {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Accept-Encoding": "gzip",
          },
          next: { revalidate: 86400 }, // Cache for 24 hours
          signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));

        if (apiResponse.ok) {
          const data = await apiResponse.json();
          const slug = data?.data?.attributes?.Slug;
          if (slug) {
            const canonical = safeDecodeURIComponent(String(slug));
            // Redirect numeric IDs always, and any path segment that is not
            // already the canonical (decoded) slug — including historical
            // percent-encoded imports like `%d8%b3…-y00574`.
            if (looksNumeric || identifier !== canonical) {
              const url = request.nextUrl.clone();
              url.pathname = `/pdp/${encodePathSegment(canonical)}`;
              return redirectWithSecurityHeaders(url, LEGACY_REDIRECT_STATUS);
            }
          }
        }
      } catch (error) {
        // Log error but don't block request - let it pass through
        console.error("[Middleware] Error redirecting product URL:", error);
      }
    }
  }

  // Redirect www to non-www (or vice versa) if needed
  // Uncomment and adjust if you have a preference
  // const hostname = request.headers.get('host') || '';
  // if (hostname.startsWith('www.')) {
  //   const url = request.nextUrl.clone();
  //   url.hostname = hostname.replace('www.', '');
  //   return redirectWithSecurityHeaders(url, 301);
  // }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes) - excluded because Next.js handles API route caching
     * - _next/static (static files) - excluded because Next.js handles static file caching
     * - _next/image (image optimization files) - excluded for performance
     * - favicon.ico (favicon file) - excluded for performance
     *
     * Cache-control headers for excluded paths are handled by Next.js automatically.
     */
    "/((?!api|_next/static|_next/image|favicon.ico).*)",
  ],
};
