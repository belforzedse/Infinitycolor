import { clearCentralAuthForLogout } from "@/lib/central-auth";
import { clearAuthRouteHint } from "@/utils/authRouteHint";

/** Legacy constants remain for test/source compatibility; no token uses browser storage. */
export const ACCESS_TOKEN_STORAGE_KEY = "accessToken";
export const ACCESS_TOKEN_EVENT = "infinity-auth-state-change";

export function setAccessToken(_token: string): never {
  throw new Error("Reusable auth credentials may not be persisted in the storefront");
}

export function clearAccessToken(): void {
  clearCentralAuthForLogout();
  clearAuthRouteHint();
}
