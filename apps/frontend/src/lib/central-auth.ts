import {
  clearStaleBrowserCredentials,
  createCentralAuthBrowserClient,
  publishAuthState,
  subscribeToAuthState,
} from "@repo/auth-core/browser";
import { exactCentralAuthOrigin } from "./central-auth-origin";

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

export function centralLoginUrl(returnPath?: string): string {
  const url = new URL("/auth", centralAuthOrigin);
  if (typeof window !== "undefined") {
    const safePath = returnPath?.startsWith("/") ? returnPath : "/";
    url.searchParams.set("returnTo", new URL(safePath, window.location.origin).toString());
  }
  return url.toString();
}

export function centralLogoutUrl(): string {
  const url = new URL("/auth/logout", centralAuthOrigin);
  if (typeof window !== "undefined") {
    url.searchParams.set("returnTo", `${window.location.origin}/auth/logout-callback`);
  }
  return url.toString();
}
