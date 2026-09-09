import type { CentralAuthBrowserError } from "@repo/auth-core/browser";

function asAuthError(error: unknown): Partial<CentralAuthBrowserError> {
  if (typeof error !== "object" || error === null) return {};
  return error as Partial<CentralAuthBrowserError>;
}

export function isUnauthorizedAuthError(error: unknown): boolean {
  return asAuthError(error).status === 401;
}

/**
 * Better Auth `GET /list-sessions` uses `freshSessionMiddleware`. The default
 * `freshAge` is one day, and this deployment never refreshes `createdAt`
 * (`disableSessionRefresh`). After that window the endpoint returns
 * `SESSION_NOT_FRESH` even though the central session is still valid.
 */
export function isSessionFreshnessError(error: unknown): boolean {
  return asAuthError(error).code === "SESSION_NOT_FRESH";
}

/**
 * Profile 401 means the bearer JWT is gone and the admin shell should restore
 * the central session. Session-list/revoke failures must not: silent
 * `/infinity/session/continue` reuses the same stale session, so sending the
 * account page back to `/auth` loops.
 */
export function shouldRedirectAccountToLogin(
  error: unknown,
  source: "profile" | "sessions",
): boolean {
  if (source === "sessions") return false;
  return isUnauthorizedAuthError(error);
}

export function sessionsNeedStepUp(error: unknown): boolean {
  return isSessionFreshnessError(error) || isUnauthorizedAuthError(error);
}
