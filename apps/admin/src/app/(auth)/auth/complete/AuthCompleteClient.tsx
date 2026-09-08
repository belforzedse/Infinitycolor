"use client";

import { useEffect, useRef, useState } from "react";
import {
  AuthHandoffError,
  authErrorStatus,
  updateRouteHint,
  withTransientAuthRetry,
} from "@repo/auth-core/browser";
import {
  currentUserAtom,
  userErrorAtom,
  userLoadingAtom,
} from "@/lib/atoms/auth";
import { jotaiStore } from "@/lib/jotaiStore";
import {
  centralAuth,
  centralAuthOrigin,
  initializeCentralAuthBrowser,
} from "@/lib/central-auth";
import UserService from "@/services/user";
import { getAdminLandingPath } from "@/constants/roleAccess";
import { adminOrigin, storefrontOrigin } from "@/config/admin-env";

export default function AuthCompleteClient({
  returnPath,
  attempt,
  callbackError,
}: {
  returnPath: string;
  attempt: number;
  callbackError?: string;
}) {
  const started = useRef<string | null>(null);
  const [fatal, setFatal] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const runKey = `${attempt}:${retryKey}`;
    if (started.current === runKey) return;
    started.current = runKey;
    setFatal("");
    const restore = async () => {
      try {
        if (callbackError) {
          throw new AuthHandoffError(
            "مجوز بازگشت معتبر نیست. دوباره وارد شوید.",
            401,
          );
        }
        initializeCentralAuthBrowser();
        const token = await withTransientAuthRetry(() =>
          centralAuth.tokenManager.getToken({ forceRefresh: true }),
        );
        if (!token) throw new AuthHandoffError("نشست فعال یافت نشد", 401);
        const me = await withTransientAuthRetry(() => UserService.me(true));
        if (!me.isAdmin) {
          centralAuth.tokenManager.expire();
          await withTransientAuthRetry(() => updateRouteHint("DELETE"));
          window.location.replace(
            new URL("/account", storefrontOrigin()).toString(),
          );
          return;
        }
        await withTransientAuthRetry(() => updateRouteHint("PUT"));
        jotaiStore.set(currentUserAtom, me);
        jotaiStore.set(userLoadingAtom, false);
        jotaiStore.set(userErrorAtom, null);
        window.location.replace(
          returnPath === "/"
            ? getAdminLandingPath(me.capabilities, me.adminRole)
            : returnPath,
        );
      } catch (cause) {
        if (authErrorStatus(cause) !== 401) {
          setFatal("بازیابی حساب موقتاً ممکن نیست. دوباره تلاش کنید.");
          return;
        }
        centralAuth.tokenManager.expire();
        if (attempt >= 2) {
          setFatal(
            cause instanceof Error ? cause.message : "بازیابی نشست ناموفق بود",
          );
          return;
        }
        try {
          await updateRouteHint("POST");
        } catch {
          setFatal("بازیابی حساب موقتاً ممکن نیست. دوباره تلاش کنید.");
          return;
        }
        const login = new URL("/auth", centralAuthOrigin);
        login.searchParams.set(
          "returnTo",
          new URL(returnPath, adminOrigin()).toString(),
        );
        window.location.replace(login.toString());
      }
    };
    void restore();
  }, [attempt, callbackError, retryKey, returnPath]);

  return (
    <main
      className="flex min-h-screen items-center justify-center p-6"
      dir="rtl"
    >
      <div
        className="max-w-md rounded-prominent border bg-white p-8 text-center"
        role={fatal ? "alert" : "status"}
      >
        {fatal ? (
          <>
            <p className="text-red-700">{fatal}</p>
            <button
              type="button"
              className="mt-4 rounded-full bg-infinity-primary px-5 py-2 text-white"
              onClick={() => setRetryKey((value) => value + 1)}
            >
              تلاش دوباره
            </button>
            <a
              className="mt-4 inline-block text-infinity-primary underline"
              href={centralAuthOrigin}
            >
              تلاش دوباره برای ورود
            </a>
          </>
        ) : (
          <p>در حال بازیابی حساب مدیریتی...</p>
        )}
      </div>
    </main>
  );
}
