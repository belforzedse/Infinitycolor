"use client";

import { useEffect } from "react";
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
} from "@/lib/central-auth";
import { clearUserStorage } from "@/utils/userStorage";
import { isProfileIncomplete } from "@/utils/profile";
import { isAuthRequiredRoute } from "@/utils/routeAccessPolicy";

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

async function clearStaleRouteHint(): Promise<void> {
  const protectedRoute = isAuthRequiredRoute(window.location.pathname);
  await fetch("/api/auth/route-hint", {
    method: protectedRoute ? "POST" : "DELETE",
    credentials: "same-origin",
    cache: "no-store",
  }).catch(() => undefined);

  if (protectedRoute) {
    const login = new URL("/auth", centralAuthOrigin);
    login.searchParams.set("returnTo", window.location.href);
    window.location.replace(login.toString());
  }
}

/** Restores a Better Auth session by obtaining a short-lived in-memory API JWT. */
export default function AuthInitializer() {
  const setUser = useSetAtom(currentUserAtom);
  const setIsLoading = useSetAtom(userLoadingAtom);
  const setError = useSetAtom(userErrorAtom);

  useEffect(() => {
    let active = true;
    initializeCentralAuthBrowser();

    const restore = async (forceRefresh = false) => {
      if (!active) return;
      setIsLoading(true);
      try {
        const token = await centralAuth.tokenManager.getToken({ forceRefresh });
        if (!active) return;
        if (!token) {
          clearIdentityState();
          await clearStaleRouteHint();
          return;
        }
        const me = await UserService.me();
        if (!active) return;
        if (!me.isAdmin && isProfileIncomplete(me)) {
          clearIdentityState();
          await fetch("/api/auth/route-hint", {
            method: "DELETE",
            credentials: "same-origin",
            cache: "no-store",
          }).catch(() => undefined);
          const completion = new URL("/auth/register/info", centralAuthOrigin);
          completion.searchParams.set("returnTo", window.location.href);
          window.location.replace(completion.toString());
          return;
        }
        setUser(me);
        setError(null);
      } catch (cause) {
        if (!active) return;
        centralAuth.tokenManager.expire();
        clearIdentityState();
        const error = cause instanceof Error ? cause : new Error("Failed to restore session");
        setError(error);
        await clearStaleRouteHint();
      } finally {
        if (active) setIsLoading(false);
      }
    };

    void restore();
    const unsubscribe = subscribeToAuthState((event) => {
      if (event.type === "logout") {
        clearIdentityState();
        setIsLoading(false);
        return;
      }
      void restore(true);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [setError, setIsLoading, setUser]);

  return null;
}
