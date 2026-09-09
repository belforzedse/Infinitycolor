import {
  clearStaleBrowserCredentials,
  createCentralAuthBrowserClient,
  publishAuthState,
  subscribeToAuthState,
} from "@repo/auth-core/browser";
import { safeInternalPath } from "@repo/auth-core/redirects";
import { exactCentralAuthOrigin } from "./central-auth-origin";
import { adminOrigin } from "@/config/admin-env";

export const centralAuthOrigin = exactCentralAuthOrigin();
export const centralAuth = createCentralAuthBrowserClient({ authOrigin: centralAuthOrigin });

export function initializeCentralAuthBrowser(): void {
  clearStaleBrowserCredentials();
}

export function clearCentralAuthForLogout(): void {
  centralAuth.tokenManager.clearForLogout();
  publishAuthState("logout");
}

export { publishAuthState, subscribeToAuthState };

export function centralLoginUrl(
  returnPath?: string,
  options?: { stepUp?: boolean },
): string {
  const url = new URL("/auth", centralAuthOrigin);
  if (typeof window !== "undefined") {
    const safePath = safeInternalPath(returnPath) ?? "/";
    url.searchParams.set("returnTo", new URL(safePath, adminOrigin()).toString());
    if (options?.stepUp) url.searchParams.set("stepUp", "1");
  }
  return url.toString();
}

export function centralLogoutUrl(): string {
  const url = new URL("/auth/logout", centralAuthOrigin);
  if (typeof window !== "undefined") {
    url.searchParams.set("returnTo", new URL("/auth/logout-callback", adminOrigin()).toString());
  }
  return url.toString();
}
