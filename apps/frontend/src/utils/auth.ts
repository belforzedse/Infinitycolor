import { HTTP_STATUS } from "@/constants/api";
import { jotaiStore } from "@/lib/jotaiStore";
import { errorNotificationsAtom, addErrorNotification } from "@/lib/atoms/errors";
import { currentUserAtom } from "@/lib/atoms/auth";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import { clearAccessToken } from "@/utils/accessToken";
import { centralAuth, centralLoginUrl } from "@/lib/central-auth";
import { safeInternalRedirect } from "@/utils/authRedirect";
import { isAuthRequiredRoute } from "@/utils/routeAccessPolicy";
import { clearUserStorage } from "@/utils/userStorage";

let pendingAuthRedirect: string | null = null;

/**
 * A single 401 on an otherwise-live session is usually the ~60s bridge JWT
 * going stale between mint and use (e.g. a checkout form left open), not an
 * actual logout -- the underlying Better Auth session is still good. Try one
 * silent refresh before tearing down local state and redirecting to login.
 * This never replays the request that got the 401 (mutations are never
 * auto-retried, see apps/auth/src/security-contract.test.ts); it only
 * decides whether the user is still authenticated so a stale-token blip
 * doesn't wipe an in-progress form for a session that is actually fine.
 */
async function handleUnauthorized(error: any, isJest: unknown): Promise<void> {
  const refreshed = await centralAuth.tokenManager
    .getToken({ forceRefresh: true })
    .catch(() => null);

  if (refreshed) {
    if (!isJest) {
      const notification = addErrorNotification(
        401,
        "نشست شما به‌روزرسانی شد. لطفاً دوباره تلاش کنید.",
      );
      jotaiStore.set(errorNotificationsAtom, (prev) => [...prev, notification]);
    }
    return;
  }

  clearAccessToken();
  clearUserStorage();
  jotaiStore.set(currentUserAtom, null);

  const requestedPath = safeInternalRedirect(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
  if (requestedPath && isAuthRequiredRoute(window.location.pathname)) {
    const target = centralLoginUrl(requestedPath);
    if (pendingAuthRedirect !== target) {
      pendingAuthRedirect = target;
      window.location.replace(target);
    }
    return;
  }

  // Public routes remain usable; offer login without forcing navigation.
  if (!isJest) {
    const notification = addErrorNotification(
      401,
      getUserFacingErrorMessage(error, "برای دیدن این بخش باید وارد حساب خود شوید."),
    );
    jotaiStore.set(errorNotificationsAtom, (prev) => [...prev, notification]);
  }
}

/**
 * Handles authentication errors (401, 403) gracefully
 * Shows user-friendly notifications instead of hard redirects
 *
 * 401 (Unauthorized): Shows notification with login link
 * 403 (Forbidden): Shows notification explaining permission denied
 * isAdminCheck: Shows notification instead of redirecting
 */
export const handleAuthErrors = (
  error?: any,
  isAdminCheck?: boolean,
): void | Promise<void> => {
  // TODO: Replace `any` with a specific error type for stricter checking
  const isUnauthorized = error?.status === HTTP_STATUS.UNAUTHORIZED;
  const isForbidden = error?.status === HTTP_STATUS.FORBIDDEN;
  const isNotAdmin = isAdminCheck === false;

  if (!isUnauthorized && !isForbidden && !isNotAdmin) {
    return;
  }

  const isJest = typeof process !== "undefined" && process.env?.JEST_WORKER_ID;

  if (typeof window === "undefined") {
    return;
  }

  // 401: User not authenticated. Callers treat this as fire-and-forget (its
  // return type is void), but it is a real Promise so tests can await it.
  if (isUnauthorized) {
    return handleUnauthorized(error, isJest);
  }

  // 403: User forbidden/permission denied
  // NOTE: We do NOT clear the access token here - user stays logged in
  // We also keep cached user data so customer-only permission errors do not
  // make protected customer layouts treat the user as logged out.
  if (isForbidden) {
    if (!isJest) {
      const notification = addErrorNotification(
        403,
        getUserFacingErrorMessage(error, "این بخش برای حساب شما در دسترس نیست."),
      );
      jotaiStore.set(errorNotificationsAtom, (prev) => [...prev, notification]);
    }
    return;
  }

  // isNotAdmin: Not an admin user
  if (isNotAdmin && !isJest) {
    const notification = addErrorNotification(
      403,
      "این صفحه فقط برای مدیران در دسترس است.",
    );
    jotaiStore.set(errorNotificationsAtom, (prev) => [...prev, notification]);
  }
};

export async function getAccessToken(): Promise<string | null> {
  return centralAuth.tokenManager.getToken();
}

/**
 * Normalizes Iranian phone numbers to the +98XXXXXXXXXX format
 * Converts from formats like:
 * - 09XXXXXXXXX → +989XXXXXXXXX
 * - 989XXXXXXXXX → +989XXXXXXXXX
 * - +989XXXXXXXXX → +989XXXXXXXXX (unchanged)
 */
export function normalizePhoneNumber(value: string): string {
  if (!value) return value;
  let trimmed = value.trim();
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.startsWith("0")) trimmed = trimmed.substring(1);
  if (!trimmed.startsWith("98")) trimmed = `98${trimmed}`;
  return `+${trimmed}`;
}
