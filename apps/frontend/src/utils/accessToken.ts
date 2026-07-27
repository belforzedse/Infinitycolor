import {
  ACCESS_TOKEN_EVENT,
  ACCESS_TOKEN_STORAGE_KEY,
  clearAccessToken as clearStoredAccessToken,
  setAccessToken as setStoredAccessToken,
} from "@repo/api/token";
import { clearAuthRouteHint, setAuthRouteHint } from "@/utils/authRouteHint";

export { ACCESS_TOKEN_EVENT, ACCESS_TOKEN_STORAGE_KEY };

export function setAccessToken(token: string): void {
  setStoredAccessToken(token);
  setAuthRouteHint();
}

export function clearAccessToken(): void {
  try {
    clearStoredAccessToken();
  } finally {
    clearAuthRouteHint();
  }
}
