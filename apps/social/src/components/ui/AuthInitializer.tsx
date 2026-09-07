"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { currentUserAtom, userLoadingAtom, userErrorAtom } from "@/lib/atoms/auth";
import UserService from "@/services/user";
import {
  centralAuth,
  centralAuthOrigin,
  initializeCentralAuthBrowser,
  subscribeToAuthState,
} from "@/lib/central-auth";
import { isProfileIncomplete } from "@/utils/profile";
import { isAuthRequiredRoute } from "@/utils/routeAccessPolicy";

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
          setUser(null);
          setError(null);
          await clearStaleRouteHint();
          return;
        }
        const me = await UserService.me();
        if (!active) return;
        if (!me.isAdmin && isProfileIncomplete(me)) {
          setUser(null);
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
        setUser(null);
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
        setUser(null);
        setError(null);
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
