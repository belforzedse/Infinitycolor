import { HTTP_STATUS } from "@repo/api/config";
import type { ApiError } from "@repo/api/types";
import { currentUserAtom } from "@/lib/atoms/auth";
import { jotaiStore } from "@/lib/jotaiStore";
import { clearAccessToken } from "@/utils/accessToken";
import { centralAuth, centralLoginUrl } from "@/lib/central-auth";
import { isAuthRequiredRoute } from "@/utils/routeAccessPolicy";

let pendingAuthRedirect: string | null = null;

/**
 * 401 expires the in-memory bearer and, on `/profile/**`, sends the visitor
 * back to central auth. 403 is a permission failure and must not look like
 * a missing session.
 */
export function handleAuthErrors(error?: ApiError | null, isAdminCheck?: boolean): void {
  const isUnauthorized = error?.status === HTTP_STATUS.UNAUTHORIZED;
  const isForbidden = error?.status === HTTP_STATUS.FORBIDDEN;
  const isNotAdmin = isAdminCheck === false;

  if (!isUnauthorized && !isForbidden && !isNotAdmin) {
    return;
  }

  if (typeof window === "undefined") {
    return;
  }

  if (isUnauthorized) {
    clearAccessToken();
    jotaiStore.set(currentUserAtom, null);
    const requestedPath = `${window.location.pathname}${window.location.search}`;
    if (isAuthRequiredRoute(window.location.pathname)) {
      const target = centralLoginUrl(requestedPath);
      if (pendingAuthRedirect !== target) {
        pendingAuthRedirect = target;
        window.location.replace(target);
      }
    }
    return;
  }

  if (isForbidden) {
    return;
  }
}

export async function getAccessToken(): Promise<string | null> {
  return centralAuth.tokenManager.getToken();
}

export function hasCachedAccessToken(): boolean {
  return Boolean(centralAuth.tokenManager.peek());
}

/**
 * Whether the visitor actually has a usable session right now.
 *
 * `hasCachedAccessToken` only reads the in-memory cache, so on a fresh page load
 * — or straight after returning from central auth — it reports false for someone
 * who is genuinely signed in. Gating actions on it told those users to sign in
 * again, which is the inconsistent account state reported against Infinitygram.
 * This asks the token manager for a token, letting it refresh when it can.
 */
export async function hasActiveSession(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (hasCachedAccessToken()) return true;
  try {
    return Boolean(await centralAuth.tokenManager.getToken());
  } catch {
    return false;
  }
}

export function normalizePhoneNumber(value: string): string {
  if (!value) return value;
  let trimmed = value.trim();
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.startsWith("0")) trimmed = trimmed.substring(1);
  if (!trimmed.startsWith("98")) trimmed = `98${trimmed}`;
  return `+${trimmed}`;
}
