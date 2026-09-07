import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_ROUTE_HINT_COOKIE, AUTH_ROUTE_HINT_COOKIE_VALUE } from "@/utils/authRouteHint";
import { isAuthRequiredRoute } from "@/utils/routeAccessPolicy";
import { exactCentralAuthOrigin } from "@/lib/central-auth-origin";
import { SITE_URL } from "@/config/site";

export const AUTH_REDIRECT_STATUS = 307;

/**
 * The hint is a routing signal only, never an authorization decision: it says
 * "this browser completed a login recently", so we can avoid painting the
 * account shell for a visitor who certainly has no session. Every API call
 * behind it still presents and validates a bearer token.
 */
function hasAuthRouteHint(request: NextRequest) {
  return request.cookies.get(AUTH_ROUTE_HINT_COOKIE)?.value === AUTH_ROUTE_HINT_COOKIE_VALUE;
}

function getAuthRedirectUrl(request: NextRequest) {
  const url = new URL("/auth", exactCentralAuthOrigin());
  const requestedPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  url.searchParams.set("returnTo", new URL(requestedPath, SITE_URL).toString());
  return url;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isAuthRequiredRoute(pathname) && !hasAuthRouteHint(request)) {
    const response = NextResponse.redirect(getAuthRedirectUrl(request), AUTH_REDIRECT_STATUS);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/profile", "/profile/:path*"],
};
