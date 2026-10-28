import {
  clearStaleBrowserCredentials,
  createCentralAuthBrowserClient,
  publishAuthState,
  subscribeToAuthState,
} from "@repo/auth-core/browser";
import { SITE_URL } from "@/config/site";
import { exactCentralAuthOrigin } from "./central-auth-origin";

export const centralAuthOrigin = exactCentralAuthOrigin();
export const centralAuth = createCentralAuthBrowserClient({
  authOrigin: centralAuthOrigin,
  // Infinitygram is a different site from auth.infinitycolor.co. Its host-only
  // application session is exchanged here so browser privacy protections never
  // need to expose the central cookie in a third-party request.
  tokenOrigin: new URL(SITE_URL).origin,
});

let authStateVersion = 0;
let observingAuthState = false;

/** Invalidate delayed identity work when another tab changes the session. */
export function readAuthStateVersion(): number {
  if (!observingAuthState && typeof window !== "undefined") {
    observingAuthState = true;
    subscribeToAuthState(() => {
      authStateVersion += 1;
      centralAuth.tokenManager.clearForLogout();
    });
  }
  return authStateVersion;
}

export function initializeCentralAuthBrowser(): void {
  readAuthStateVersion();
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
    url.searchParams.set(
      "returnTo",
      new URL(safePath, window.location.origin).toString(),
    );
  }
  return url.toString();
}

export function centralLogoutUrl(): string {
  const url = new URL("/auth/logout", centralAuthOrigin);
  if (typeof window !== "undefined") {
    url.searchParams.set(
      "returnTo",
      `${window.location.origin}/auth/logout-callback`,
    );
  }
  return url.toString();
}
