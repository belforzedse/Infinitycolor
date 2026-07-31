/**
 * A non-secret routing hint used to avoid rendering authenticated page shells
 * for logged-out visitors. This marker is deliberately not an authorization
 * credential: every private API request must still validate the bearer token.
 */
export const AUTH_ROUTE_HINT_COOKIE = "infinity_route_hint";
export const AUTH_ROUTE_HINT_COOKIE_VALUE = "1";
export const AUTH_ROUTE_HINT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function writeMarkerCookie(maxAge: number) {
  if (typeof document === "undefined") return;

  const secure =
    typeof window !== "undefined" && window.location.protocol === "https:" ? "; Secure" : "";

  document.cookie =
    [
      `${AUTH_ROUTE_HINT_COOKIE}=${AUTH_ROUTE_HINT_COOKIE_VALUE}`,
      "Path=/",
      `Max-Age=${maxAge}`,
      "SameSite=Lax",
    ].join("; ") + secure;
}

export function setAuthRouteHint(): void {
  writeMarkerCookie(AUTH_ROUTE_HINT_MAX_AGE_SECONDS);
}

export function clearAuthRouteHint(): void {
  writeMarkerCookie(0);
}
