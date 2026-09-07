import { jotaiStore } from "@/lib/jotaiStore";
import { currentUserAtom, userErrorAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { clearAllCommentDrafts } from "@/lib/offline-snapshots";
import { centralLogoutUrl, clearCentralAuthForLogout } from "@/lib/central-auth";
import { clearAuthRouteHint } from "@/utils/authRouteHint";

/**
 * Ends the Infinitygram session and hands off to central auth, which then
 * returns to `/auth/logout-callback`.
 */
export function performLogout(): void {
  if (typeof window === "undefined") return;

  try {
    jotaiStore.set(currentUserAtom, null);
    jotaiStore.set(userErrorAtom, null);
    jotaiStore.set(userLoadingAtom, false);
    clearCentralAuthForLogout();
    clearAuthRouteHint();
    clearAllCommentDrafts();
    window.location.replace(centralLogoutUrl());
  } catch (error) {
    console.error("[Logout] Error during logout:", error);
    window.location.replace(centralLogoutUrl());
  }
}
