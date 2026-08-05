import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_ROUTE_HINT_COOKIE,
  AUTH_ROUTE_HINT_COOKIE_VALUE,
} from "@/utils/authRouteHint";
import { exactCentralAuthOrigin } from "@/lib/central-auth-origin";
import { adminOrigin } from "@/config/admin-env";

const PUBLIC_PATHS = new Set([
  "/offline",
  "/manifest.webmanifest",
  "/auth/callback",
  "/auth/complete",
  "/auth/logout-callback",
  "/auth/logout-complete",
  "/api/security/csp-report",
]);

function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/api/health/") ||
    pathname === "/api/auth/route-hint" ||
    pathname === "/sw.js"
  );
}

function sourceOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function contentSecurityPolicy(nonce: string): string {
  const auth = sourceOrigin(
    process.env.NEXT_PUBLIC_AUTH_URL || process.env.NEXT_PUBLIC_AUTH_ORIGIN,
  );
  const api = sourceOrigin(
    process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL,
  );
  const image = sourceOrigin(process.env.NEXT_PUBLIC_IMAGE_BASE_URL);
  const media = sourceOrigin(process.env.NEXT_PUBLIC_MEDIA_CDN_URL);
  const sentry = sourceOrigin(process.env.NEXT_PUBLIC_SENTRY_TUNNEL_ORIGIN);
  const matomo = sourceOrigin(process.env.NEXT_PUBLIC_ADMIN_MATOMO_URL);
  const developmentScript =
    process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const developmentConnect =
    process.env.NODE_ENV === "development" ? " ws: http:" : "";
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    `img-src 'self' data: blob: ${[image, media].filter(Boolean).join(" ")}`.trim(),
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentScript}`,
    `connect-src 'self' ${[auth, api, sentry, matomo].filter(Boolean).join(" ")}${developmentConnect}`.trim(),
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self' blob:",
    "report-uri /api/security/csp-report",
  ].join("; ");
}

function withResponseHeaders(
  response: NextResponse,
  nonce: string,
  requestId: string,
): NextResponse {
  const policy = contentSecurityPolicy(nonce);
  const reportOnly =
    process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT === "staging" ||
    process.env.ADMIN_CSP_REPORT_ONLY === "true";
  response.headers.set(
    reportOnly
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy",
    policy,
  );
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Vary", "Cookie");
  response.headers.set("X-Request-Id", requestId);
  if (process.env.NODE_ENV === "production") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  return response;
}

function loginUrl(request: NextRequest): URL {
  const url = new URL("/auth", exactCentralAuthOrigin());
  const requestedPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  url.searchParams.set(
    "returnTo",
    new URL(requestedPath, adminOrigin()).toString(),
  );
  return url;
}

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  const policy = contentSecurityPolicy(nonce);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("Content-Security-Policy", policy);

  const hasHint =
    request.cookies.get(AUTH_ROUTE_HINT_COOKIE)?.value ===
    AUTH_ROUTE_HINT_COOKIE_VALUE;
  if (!isPublicPath(request.nextUrl.pathname) && !hasHint) {
    return withResponseHeaders(
      NextResponse.redirect(loginUrl(request), 307),
      nonce,
      requestId,
    );
  }

  return withResponseHeaders(
    NextResponse.next({ request: { headers: requestHeaders } }),
    nonce,
    requestId,
  );
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|icons/|images/|animations/|favicon.ico|favicon.svg|Infinity.svg|Logo.png).*)",
  ],
};
