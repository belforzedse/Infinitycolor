"use client";

import { useEffect, useRef, useState } from "react";
import { currentUserAtom, userErrorAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { jotaiStore } from "@/lib/jotaiStore";
import { centralAuth, centralAuthOrigin, initializeCentralAuthBrowser, publishAuthState } from "@/lib/central-auth";
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
  const started = useRef(false);
  const [fatal, setFatal] = useState("");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const restore = async () => {
      try {
        if (callbackError) throw new Error("مجوز بازگشت معتبر نیست. دوباره وارد شوید.");
        initializeCentralAuthBrowser();
        const token = await centralAuth.tokenManager.getToken({ forceRefresh: true });
        if (!token) throw new Error("نشست فعال یافت نشد");
        const me = await UserService.me(true);
        if (!me.isAdmin) {
          centralAuth.tokenManager.expire();
          await fetch("/api/auth/route-hint", { method: "DELETE", credentials: "same-origin" });
          window.location.replace(new URL("/account", storefrontOrigin()).toString());
          return;
        }
        jotaiStore.set(currentUserAtom, me);
        jotaiStore.set(userLoadingAtom, false);
        jotaiStore.set(userErrorAtom, null);
        publishAuthState("session-changed");
        await fetch("/api/auth/route-hint", { method: "PUT", credentials: "same-origin" });
        window.location.replace(
          returnPath === "/"
            ? getAdminLandingPath(me.capabilities, me.adminRole)
            : returnPath,
        );
      } catch (cause) {
        centralAuth.tokenManager.expire();
        await fetch("/api/auth/route-hint", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
        if (attempt >= 2) {
          setFatal(cause instanceof Error ? cause.message : "بازیابی نشست ناموفق بود");
          return;
        }
        const login = new URL("/auth", centralAuthOrigin);
        login.searchParams.set("returnTo", new URL(returnPath, adminOrigin()).toString());
        window.location.replace(login.toString());
      }
    };
    void restore();
  }, [attempt, callbackError, returnPath]);

  return (
    <main className="flex min-h-screen items-center justify-center p-6" dir="rtl">
      <div className="max-w-md rounded-2xl border bg-white p-8 text-center" role={fatal ? "alert" : "status"}>
        {fatal ? (
          <>
            <p className="text-red-700">{fatal}</p>
            <a className="mt-4 inline-block text-infinity-primary underline" href={centralAuthOrigin}>
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
