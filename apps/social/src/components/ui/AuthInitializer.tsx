"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import {
  currentUserAtom,
  userLoadingAtom,
  userErrorAtom,
} from "@/lib/atoms/auth";
import UserService from "@/services/user";
import {
  centralAuth,
  centralAuthOrigin,
  initializeCentralAuthBrowser,
  subscribeToAuthState,
  readAuthStateVersion,
} from "@/lib/central-auth";
import { authErrorStatus } from "@repo/auth-core/browser";
import { logDiagnostic } from "@/lib/diagnostic-log";
import { isProfileIncomplete } from "@/utils/profile";
import { isAuthRequiredRoute } from "@/utils/routeAccessPolicy";

async function clearStaleRouteHint(current: () => boolean): Promise<void> {
  const protectedRoute = isAuthRequiredRoute(window.location.pathname);
  await fetch("/api/auth/route-hint", {
    method: protectedRoute ? "POST" : "DELETE",
    credentials: "same-origin",
    cache: "no-store",
  }).catch(() => undefined);

  if (current() && protectedRoute) {
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

    let operation = 0;
    let lastAttempt = -Infinity;
    const restore = async (forceRefresh = false) => {
      const run = ++operation;
      const version = readAuthStateVersion();
      const current = () =>
        active && run === operation && version === readAuthStateVersion();
      lastAttempt = Date.now();
      setIsLoading(true);
      try {
        const outcome = await centralAuth.tokenManager.getTokenOutcome({
          forceRefresh,
        });
        if (!current() || outcome.state === "invalidated") return;
        if (outcome.state === "unavailable") {
          setError(new Error("بررسی حساب موقتاً ممکن نیست."));
          logDiagnostic("auth.recovery", {
            operation: "initialize",
            outcome: "unavailable",
          });
          return;
        }
        if (outcome.state === "unauthenticated") {
          setUser(null);
          setError(null);
          await clearStaleRouteHint(current);
          return;
        }
        const me = await UserService.me();
        if (!current()) return;
        if (!me.isAdmin && isProfileIncomplete(me)) {
          await fetch("/api/auth/route-hint", {
            method: "DELETE",
            credentials: "same-origin",
            cache: "no-store",
          }).catch(() => undefined);
          if (!current()) return;
          const completion = new URL("/auth/register/info", centralAuthOrigin);
          completion.searchParams.set("returnTo", window.location.href);
          window.location.replace(completion.toString());
          return;
        }
        setUser(me);
        setError(null);
        logDiagnostic("auth.recovery", {
          operation: "initialize",
          outcome: "recovered",
        });
      } catch (cause) {
        if (!current()) return;
        if (authErrorStatus(cause) === 401) {
          const outcome = await centralAuth.tokenManager.getTokenOutcome({
            forceRefresh: true,
          });
          if (!current()) return;
          if (outcome.state === "unauthenticated") {
            setUser(null);
            setError(null);
            await clearStaleRouteHint(current);
            return;
          }
        }
        setError(new Error("بررسی حساب موقتاً ممکن نیست."));
        logDiagnostic("auth.recovery", {
          operation: "initialize",
          outcome: "unavailable",
          http_status: authErrorStatus(cause),
        });
      } finally {
        if (current()) setIsLoading(false);
      }
    };

    void restore();
    const unsubscribe = subscribeToAuthState((event) => {
      operation += 1;
      if (event.type === "logout") {
        setUser(null);
        setError(null);
        setIsLoading(false);
        return;
      }
      setUser(null);
      void restore(true);
    });
    const retry = () => {
      if (Date.now() - lastAttempt >= 30_000) void restore(true);
    };
    window.addEventListener("focus", retry);
    window.addEventListener("online", retry);
    return () => {
      active = false;
      window.removeEventListener("focus", retry);
      window.removeEventListener("online", retry);
      unsubscribe();
    };
  }, [setError, setIsLoading, setUser]);

  return null;
}
