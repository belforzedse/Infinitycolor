const PRIVATE_ROUTE_PREFIXES = [
  "/account",
  "/addresses",
  "/cart",
  "/checkout",
  "/favorites",
  "/orders",
  "/password",
  "/payment",
  "/privileges",
  "/super-admin",
  "/wallet",
] as const;

const AUTH_REQUIRED_ROUTE_PREFIXES = [
  "/account",
  "/addresses",
  "/checkout",
  "/favorites",
  "/orders",
  "/password",
  "/privileges",
  "/super-admin",
  "/wallet",
] as const;

const PUBLIC_ORDER_ROUTE_PREFIXES = [
  "/orders/failure",
  "/orders/payment-callback",
  "/orders/success",
] as const;

function matchesRoutePrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isPrivateRoute(pathname: string) {
  return PRIVATE_ROUTE_PREFIXES.some((prefix) => matchesRoutePrefix(pathname, prefix));
}

export function isAuthRequiredRoute(pathname: string) {
  if (PUBLIC_ORDER_ROUTE_PREFIXES.some((prefix) => matchesRoutePrefix(pathname, prefix))) {
    return false;
  }

  return AUTH_REQUIRED_ROUTE_PREFIXES.some((prefix) => matchesRoutePrefix(pathname, prefix));
}
