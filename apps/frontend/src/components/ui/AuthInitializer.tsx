"use client";

import { useEffect } from "react";
import { updateRouteHint } from "@repo/auth-core/browser";
import { useSetAtom } from "jotai";
import { currentUserAtom, userLoadingAtom, userErrorAtom } from "@/lib/atoms/auth";
import { addressesAtom, addressesLoadingAtom, addressesErrorAtom } from "@/atoms/addressesAtom";
import {
  likedProductsAtom,
  likedProductsLoadedAtom,
  likedProductsOwnerAtom,
} from "@/hooks/useProductLike";
import {
  submitOrderStepAtom,
  orderIdAtom,
  orderNumberAtom,
  transactionIdAtom,
} from "@/atoms/Order";
import { SubmitOrderStep } from "@/types/Order";
import UserService from "@/services/user";
import { __clearOrderCache } from "@/services/order";
import { invalidateAddressCache } from "@/services/user/addresses";
import { jotaiStore } from "@/lib/jotaiStore";
import {
  centralAuth,
  centralAuthOrigin,
  initializeCentralAuthBrowser,
  subscribeToAuthState,
  readAuthStateVersion,
} from "@/lib/central-auth";
import { logDiagnostic } from "@/lib/diagnostic-log";
import { clearUserStorage } from "@/utils/userStorage";
import { isProfileIncomplete } from "@/utils/profile";
import { isAuthRequiredRoute } from "@/utils/routeAccessPolicy";
import { HTTP_STATUS } from "@/constants/api";

function clearIdentityState() {
  jotaiStore.set(currentUserAtom, null);
  jotaiStore.set(userErrorAtom, null);
  jotaiStore.set(addressesAtom, []);
  jotaiStore.set(addressesLoadingAtom, false);
  jotaiStore.set(addressesErrorAtom, null);
  invalidateAddressCache();
  jotaiStore.set(likedProductsAtom, []);
  jotaiStore.set(likedProductsLoadedAtom, false);
  // Clearing the owner is what lets the next identity fetch. There is no module-level
  // "already fetched" flag to reset any more: the hook keys its state on the
  // authenticated user id, so a new identity is simply a new key.
  jotaiStore.set(likedProductsOwnerAtom, null);
  jotaiStore.set(orderIdAtom, null);
  jotaiStore.set(orderNumberAtom, null);
  jotaiStore.set(transactionIdAtom, null);
  jotaiStore.set(submitOrderStepAtom, SubmitOrderStep.Table);
  __clearOrderCache();
  clearUserStorage();
}

async function clearStaleRouteHint(isCurrent: () => boolean): Promise<void> {
  const protectedRoute = isAuthRequiredRoute(window.location.pathname);
  await updateRouteHint(protectedRoute ? "POST" : "DELETE").catch(() => undefined);

  if (protectedRoute && isCurrent()) {
    const login = new URL("/auth", centralAuthOrigin);
    login.searchParams.set("returnTo", window.location.href);
    window.location.replace(login.toString());
  }
}

/** Throttle so a tab-switch storm cannot mint tokens in a loop. */
const REVALIDATE_MIN_INTERVAL_MS = 30_000;

/** Restores a Better Auth session by obtaining a short-lived in-memory API JWT. */
export default function AuthInitializer() {
  const setUser = useSetAtom(currentUserAtom);
  const setIsLoading = useSetAtom(userLoadingAtom);
  const setError = useSetAtom(userErrorAtom);

  useEffect(() => {
    if (window.location.pathname === "/auth/complete") return;
    let active = true;
    let operationVersion = 0;
    initializeCentralAuthBrowser();

    const restore = async (forceRefresh = false) => {
      if (!active) return;
      const operation = ++operationVersion;
      const identity = readAuthStateVersion();
      const isCurrent = () =>
        active && operation === operationVersion && identity === readAuthStateVersion();
      setIsLoading(true);
      try {
        const outcome = await centralAuth.tokenManager.getTokenOutcome({ forceRefresh });
        if (!isCurrent() || outcome.state === "invalidated") return;
        logDiagnostic("auth.recovery", {
          operation: "initialize",
          outcome: outcome.state,
          ...(outcome.state === "unavailable"
            ? { reasonCode: outcome.reasonCode, http_status: outcome.status }
            : {}),
        });
        if (outcome.state === "unavailable") {
          setError(new Error("بازیابی حساب موقتاً ممکن نیست. دوباره تلاش کنید."));
          return;
        }
        if (outcome.state === "unauthenticated") {
          clearIdentityState();
          await clearStaleRouteHint(isCurrent);
          return;
        }
        const me = await UserService.me();
        if (!isCurrent()) return;
        if (!me.isAdmin && isProfileIncomplete(me)) {
          clearIdentityState();
          await updateRouteHint("DELETE").catch(() => undefined);
          if (!isCurrent()) return;
          const completion = new URL("/auth/register/info", centralAuthOrigin);
          completion.searchParams.set("returnTo", window.location.href);
          window.location.replace(completion.toString());
          return;
        }
        setUser(me);
        setError(null);
      } catch (cause) {
        if (!isCurrent()) return;
        const error = cause instanceof Error ? cause : new Error("Failed to restore session");
        setError(error);
        const status =
          typeof cause === "object" && cause !== null && "status" in cause
            ? Number((cause as { status?: unknown }).status)
            : undefined;
        if (status === HTTP_STATUS.UNAUTHORIZED) {
          const outcome = await centralAuth.tokenManager.getTokenOutcome({ forceRefresh: true });
          if (isCurrent() && outcome.state === "unauthenticated") {
            clearIdentityState();
            await clearStaleRouteHint(isCurrent);
          }
        }
      } finally {
        if (isCurrent()) setIsLoading(false);
      }
    };

    /**
     * A session can die somewhere this tab never hears about: a password reset happens on
     * the central auth origin, revokes every session there, and publishes no event here.
     * Without this the tab keeps rendering the account UI with a stale identity until it
     * is reloaded, because `restore()` only ever ran on mount and on a local auth event.
     *
     * Deliberately silent rather than `restore(true)`: that flips `userLoadingAtom`, and
     * the header account menu gates on it, so the icon would flicker on every tab switch.
     */
    let lastRevalidatedAt = Date.now();
    const revalidateOnFocus = () => {
      if (!active || document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRevalidatedAt < REVALIDATE_MIN_INTERVAL_MS) return;
      lastRevalidatedAt = now;

      void (async () => {
        const operation = operationVersion;
        const identity = readAuthStateVersion();
        const isCurrent = () =>
          active && operation === operationVersion && identity === readAuthStateVersion();
        const outcome = await centralAuth.tokenManager.getTokenOutcome({ forceRefresh: true });
        if (!isCurrent() || outcome.state === "invalidated") return;
        logDiagnostic("auth.recovery", {
          operation: "focus",
          outcome: outcome.state,
          ...(outcome.state === "unavailable"
            ? { reasonCode: outcome.reasonCode, http_status: outcome.status }
            : {}),
        });
        if (outcome.state !== "unauthenticated") return;
        operationVersion += 1;
        const clearedOperation = operationVersion;
        clearIdentityState();
        setIsLoading(false);
        await clearStaleRouteHint(
          () =>
            active && clearedOperation === operationVersion && identity === readAuthStateVersion(),
        );
      })();
    };

    void restore();
    document.addEventListener("visibilitychange", revalidateOnFocus);
    const unsubscribe = subscribeToAuthState((event) => {
      operationVersion += 1;
      if (event.type === "logout") {
        clearIdentityState();
        setIsLoading(false);
        return;
      }
      // An explicit identity change cannot expose the previous user's data.
      clearIdentityState();
      void restore(true);
    });
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", revalidateOnFocus);
      unsubscribe();
    };
  }, [setError, setIsLoading, setUser]);

  return null;
}
