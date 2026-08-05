/**
 * A non-secret routing hint used to avoid rendering authenticated page shells
 * for logged-out visitors. This marker is deliberately not an authorization
 * credential: every private API request must still validate the bearer token.
 */
export const AUTH_ROUTE_HINT_COOKIE = "infinity_admin_route_hint";
export const AUTH_ROUTE_HINT_COOKIE_VALUE = "1";
export const AUTH_ROUTE_HINT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** The authenticated callback is the only code allowed to set the HttpOnly hint. */
export function setAuthRouteHint(): void {
  // Intentionally empty. Browser JavaScript cannot author the HttpOnly route hint.
}

export function clearAuthRouteHint(): void {
  if (typeof window === "undefined") return;
  void fetch("/api/auth/route-hint", {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
  });
}
