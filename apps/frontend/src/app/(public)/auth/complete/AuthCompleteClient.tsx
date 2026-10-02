"use client";

import { useEffect, useRef, useState } from "react";
import {
  AuthHandoffError,
  authErrorStatus,
  updateRouteHint,
  withTransientAuthRetry,
} from "@repo/auth-core/browser";
import { jotaiStore } from "@/lib/jotaiStore";
import { currentUserAtom, userErrorAtom, userLoadingAtom } from "@/lib/atoms/auth";
import {
  centralAuth,
  centralAuthOrigin,
  initializeCentralAuthBrowser,
  readAuthStateVersion,
} from "@/lib/central-auth";
import { logDiagnostic } from "@/lib/diagnostic-log";
import UserService from "@/services/user";
import { isProfileIncomplete } from "@/utils/profile";

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
    let active = true;
    initializeCentralAuthBrowser();
    const identity = readAuthStateVersion();
    const isCurrent = () => active && identity === readAuthStateVersion();
    const restore = async () => {
      try {
        if (callbackError && callbackError !== "grant_exchange_unavailable") {
          throw new AuthHandoffError("مجوز بازگشت معتبر نیست. دوباره وارد شوید.", 401);
        }
        const token = await withTransientAuthRetry(() =>
          centralAuth.tokenManager.getToken({ forceRefresh: true }),
        );
        if (!isCurrent()) return;
        if (!token) throw new AuthHandoffError("نشست فعال یافت نشد", 401);
        const me = await withTransientAuthRetry(() => UserService.me());
        if (!isCurrent()) return;

        if (!me.isAdmin && isProfileIncomplete(me)) {
          const url = new URL("/auth/register/info", centralAuthOrigin);
          url.searchParams.set("returnTo", new URL(returnPath, window.location.origin).toString());
          window.location.replace(url.toString());
          return;
        }

        await withTransientAuthRetry(() => updateRouteHint("PUT"));
        if (!isCurrent()) return;
        jotaiStore.set(currentUserAtom, me);
        jotaiStore.set(userLoadingAtom, false);
        jotaiStore.set(userErrorAtom, null);
        logDiagnostic("auth.recovery", { operation: "complete", outcome: "recovered" });
        const destination = returnPath !== "/" ? returnPath : "/account";
        window.location.replace(destination);
      } catch (cause) {
        if (!isCurrent()) return;
        logDiagnostic("auth.recovery", {
          operation: "complete",
          outcome: authErrorStatus(cause) === 401 ? "unauthenticated" : "unavailable",
          http_status: authErrorStatus(cause),
        });
        if (authErrorStatus(cause) !== 401) {
          setFatal("بازیابی حساب موقتاً ممکن نیست. دوباره تلاش کنید.");
          return;
        }
        centralAuth.tokenManager.expire();
        if (attempt >= 2) {
          setFatal(cause instanceof Error ? cause.message : "بازیابی نشست ناموفق بود");
          return;
        }
        try {
          await updateRouteHint("POST");
        } catch {
          setFatal("بازیابی حساب موقتاً ممکن نیست. دوباره تلاش کنید.");
          return;
        }
        if (!isCurrent()) return;
        const login = new URL("/auth", centralAuthOrigin);
        login.searchParams.set("returnTo", new URL(returnPath, window.location.origin).toString());
        window.location.replace(login.toString());
      }
    };
    void restore();
    return () => {
      active = false;
      if (started.current === runKey) started.current = null;
    };
  }, [attempt, callbackError, retryKey, returnPath]);

  return (
    <main className="flex min-h-[60vh] items-center justify-center p-6" dir="rtl">
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
            <a className="mt-4 inline-block text-infinity-primary underline" href="/">
              بازگشت به فروشگاه
            </a>
          </>
        ) : (
          <p>در حال بازیابی حساب کاربری...</p>
        )}
      </div>
    </main>
  );
}
