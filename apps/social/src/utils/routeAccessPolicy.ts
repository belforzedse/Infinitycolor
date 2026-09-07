/**
 * Infinitygram's authenticated surface. `/profile/**` renders the account
 * shell (header + sidebar) and immediately calls bookmark / post endpoints
 * with a bearer token, so a logged-out visitor used to see the shell paint and
 * then collapse into an error toast. The proxy redirects these to central auth
 * before any of that renders.
 */
const AUTH_REQUIRED_ROUTE_PREFIXES = ["/profile"] as const;

function matchesRoutePrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isAuthRequiredRoute(pathname: string) {
  return AUTH_REQUIRED_ROUTE_PREFIXES.some((prefix) => matchesRoutePrefix(pathname, prefix));
}
